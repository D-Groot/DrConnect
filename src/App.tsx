import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Phone, X } from 'lucide-react';
import { AnalyticsTrendsSection } from './components/AnalyticsTrendsSection';
import { AppointmentsLedger } from './components/AppointmentsLedger';
import { CallLogsView } from './components/CallLogsView';
import { DoctorsDirectory } from './components/DoctorsDirectory';
import { LiveTranscriptPanel } from './components/LiveTranscriptPanel';
import { ManualBookingModal } from './components/ManualBookingModal';
import { PhoneCallOverlay } from './components/PhoneCallOverlay';
import type {
  Appointment,
  BootstrapPayload,
  CallLog,
  CallState,
  Doctor,
  PipelineCapabilities,
  Slot,
  TranscriptEntry,
} from './types/clinic';
import { VoiceAudioEngine } from './utils/audioEngine';
import { downloadAppointmentToken } from './utils/downloadToken';

type NavTab = 'overview' | 'doctors' | 'appointments' | 'calls';

function buildWsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [capabilities, setCapabilities] = useState<PipelineCapabilities | null>(null);

  // Highlight state for live visual feedback when agent books/cancels
  const [highlightedAppointmentId, setHighlightedAppointmentId] = useState<string | null>(null);
  const [highlightAction, setHighlightAction] = useState<'booked' | 'cancelled' | null>(null);
  const [highlightedSlotId, setHighlightedSlotId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Manual booking modal state
  const [manualBookingTarget, setManualBookingTarget] = useState<{
    doctor: Doctor;
    slot: Slot;
  } | null>(null);
  const [lastBookedAppointment, setLastBookedAppointment] = useState<Appointment | null>(null);

  // Phone call state
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneMinimized, setPhoneMinimized] = useState(false);
  const [callState, setCallState] = useState<CallState>('idle');
  const [agentStatus, setAgentStatus] = useState<
    'listening' | 'transcribing' | 'thinking' | 'speaking'
  >('listening');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioSource, setAudioSource] = useState<'mic' | 'agent' | 'idle'>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [bookingCard, setBookingCard] = useState<{
    action: 'booked' | 'cancelled';
    appointment: Appointment;
  } | null>(null);
  const [callProviders, setCallProviders] = useState<{
    stt: string;
    tts: string;
    llm: string;
  } | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<'ritu' | 'shubh'>('ritu');

  const voiceWsRef = useRef<WebSocket | null>(null);
  const audioEngineRef = useRef<VoiceAudioEngine | null>(null);
  const speakerMutedRef = useRef(false);
  const callReadyRef = useRef(false);
  const agentStatusRef = useRef<'listening' | 'transcribing' | 'thinking' | 'speaking'>('listening');
  const callTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  useEffect(() => {
    agentStatusRef.current = agentStatus;
  }, [agentStatus]);

  useEffect(() => {
    speakerMutedRef.current = speakerMuted;
    if (speakerMuted) {
      audioEngineRef.current?.stopThinkingTone();
      audioEngineRef.current?.stopAgentPlayback(false);
    }
  }, [speakerMuted]);

  // Subtle waiting chime while assistant is transcribing or preparing its response
  useEffect(() => {
    const engine = audioEngineRef.current;
    if (!engine) return;
    if (
      callState === 'connected' &&
      !speakerMuted &&
      (agentStatus === 'thinking' || agentStatus === 'transcribing')
    ) {
      engine.startThinkingTone();
    } else {
      engine.stopThinkingTone();
    }
  }, [agentStatus, callState, speakerMuted]);

  const fetchBootstrap = useCallback(async () => {
    try {
      const res = await fetch('/api/bootstrap');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = (await res.json()) as BootstrapPayload;
      setDoctors(data.doctors);
      setSlots(data.slots);
      setAppointments(data.appointments);
      setCallLogs(data.callLogs);
      setCapabilities(data.capabilities);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load clinic schedule.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBootstrap();
  }, [fetchBootstrap]);

  const triggerHighlight = useCallback(
    (appointmentId: string, slotId: string, action: 'booked' | 'cancelled') => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
      setHighlightedAppointmentId(appointmentId);
      setHighlightAction(action);
      setHighlightedSlotId(slotId);
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedAppointmentId(null);
        setHighlightAction(null);
        setHighlightedSlotId(null);
      }, 3200);
    },
    []
  );

  // Dashboard real-time WebSocket for live table & transcript synchronization
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(buildWsUrl('/ws/dashboard'));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            payload: Record<string, unknown>;
          };
          if (msg.type === 'appointments:changed') {
            const action = msg.payload.action as 'booked' | 'cancelled';
            const apt = msg.payload.appointment as Appointment | undefined;
            void fetchBootstrap();
            if (apt) {
              triggerHighlight(apt.id, apt.slotId, action);
            }
          } else if (msg.type === 'call_logs:updated') {
            void fetchBootstrap();
          }
        } catch {
          // Ignore malformed WS events
        }
      };
      ws.onclose = () => {
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [fetchBootstrap, triggerHighlight]);

  const cleanupCallResources = useCallback(() => {
    callReadyRef.current = false;
    if (callTimerRef.current !== null) {
      window.clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    if (audioEngineRef.current) {
      audioEngineRef.current.destroy();
      audioEngineRef.current = null;
    }
    if (voiceWsRef.current) {
      try {
        if (voiceWsRef.current.readyState === WebSocket.OPEN) {
          voiceWsRef.current.send(JSON.stringify({ type: 'end_call' }));
        }
        voiceWsRef.current.close();
      } catch {
        // Ignore
      }
      voiceWsRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cleanupCallResources();
  }, [cleanupCallResources]);

  const startVoiceCall = useCallback(async () => {
    cleanupCallResources();
    setPhoneOpen(true);
    setPhoneMinimized(false);
    setCallState('ringing');
    setAgentStatus('listening');
    setElapsedSeconds(0);
    setMuted(false);
    setTranscript([]);
    setInterimTranscript('');
    setBookingCard(null);
    setCallError(null);
    setCallProviders(null);

    const engine = new VoiceAudioEngine({
      onAudioLevel: (level, source) => {
        setAudioLevel(level);
        setAudioSource(source);
      },
      onPcmChunk: (pcm16) => {
        const ws = voiceWsRef.current;
        if (callReadyRef.current && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(pcm16);
        }
      },
      onSpeechStart: () => {
        const ws = voiceWsRef.current;
        if (callReadyRef.current && ws && ws.readyState === WebSocket.OPEN) {
          if (agentStatusRef.current === 'speaking') {
            ws.send(JSON.stringify({ type: 'barge_in' }));
            engine.stopAgentPlayback(false);
          } else {
            ws.send(JSON.stringify({ type: 'speech_start' }));
          }
        }
      },
      onSpeechEnd: () => {
        const ws = voiceWsRef.current;
        if (callReadyRef.current && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'speech_end' }));
        }
      },
      onAgentPlaybackEnd: () => {
        setAgentStatus((prev) => (prev === 'speaking' ? 'listening' : prev));
      },
      onMicError: (msg) => {
        setCallError(
          `Microphone unavailable (${msg}). You can still type messages below.`
        );
      },
    });

    audioEngineRef.current = engine;
    engine.startRingback();

    // Initialize mic in parallel with WebSocket connection
    const micPromise = engine.startMicrophone();
    const ws = new WebSocket(buildWsUrl('/ws/voice'));
    voiceWsRef.current = ws;

    ws.onopen = async () => {
      await micPromise;
      // Audible dual-tone phone ringback while connecting before front desk picks up
      window.setTimeout(() => {
        if (voiceWsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
        engine.stopRingback();
        ws.send(JSON.stringify({ type: 'start_call', speaker: selectedVoice }));
      }, 1350);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          providers?: { stt: string; tts: string; llm: string };
          entry?: TranscriptEntry;
          text?: string;
          audioBase64?: string;
          state?: 'listening' | 'transcribing' | 'thinking' | 'speaking';
          action?: 'booked' | 'cancelled';
          appointment?: Appointment;
          message?: string;
        };

        if (msg.type === 'call_ready') {
          callReadyRef.current = true;
          setCallState('connected');
          if (msg.providers) setCallProviders(msg.providers);
          if (callTimerRef.current !== null) {
            window.clearInterval(callTimerRef.current);
          }
          callTimerRef.current = window.setInterval(() => {
            setElapsedSeconds((s) => s + 1);
          }, 1000);
        } else if (msg.type === 'transcript_entry' && msg.entry) {
          setTranscript((prev) => [...prev, msg.entry!]);
        } else if (msg.type === 'interim_transcript') {
          setInterimTranscript(msg.text || '');
        } else if (msg.type === 'agent_state' && msg.state) {
          setAgentStatus(msg.state);
        } else if (msg.type === 'agent_audio' && msg.audioBase64) {
          if (!speakerMutedRef.current) {
            void engine.playBase64Audio(msg.audioBase64);
          } else {
            setAgentStatus('listening');
          }
        } else if (msg.type === 'stop_audio') {
          engine.stopAgentPlayback(false);
        } else if (msg.type === 'booking_card' && msg.action && msg.appointment) {
          setBookingCard({ action: msg.action, appointment: msg.appointment });
          void fetchBootstrap();
          triggerHighlight(msg.appointment.id, msg.appointment.slotId, msg.action);
        } else if (msg.type === 'error' && msg.message) {
          setCallError(msg.message);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      engine.stopRingback();
      setCallError('Voice connection encountered an error.');
    };

    ws.onclose = () => {
      engine.stopRingback();
      setCallState((prev) => (prev === 'idle' ? 'idle' : 'ended'));
      if (callTimerRef.current !== null) {
        window.clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
    };
  }, [cleanupCallResources, fetchBootstrap, selectedVoice, triggerHighlight]);

  const endVoiceCall = useCallback(() => {
    audioEngineRef.current?.playHangupTone();
    cleanupCallResources();
    setCallState('ended');
    setAudioLevel(0);
    setAudioSource('idle');
    setInterimTranscript('');
    void fetchBootstrap();
  }, [cleanupCallResources, fetchBootstrap]);

  const handleToggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      audioEngineRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const handleSendTextUtterance = useCallback((text: string) => {
    const ws = voiceWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      audioEngineRef.current?.stopAgentPlayback(false);
      ws.send(JSON.stringify({ type: 'user_text', text }));
    }
  }, []);

  const handleVoiceChange = useCallback((voice: 'ritu' | 'shubh') => {
    setSelectedVoice(voice);
    const ws = voiceWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_voice', speaker: voice }));
    }
  }, []);

  const handleManualBook = async (payload: {
    phoneNumber: string;
    patientName: string;
    reason: string;
    doctorName: string;
    date: string;
    time: string;
  }) => {
    const res = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { appointment?: Appointment; error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Booking failed');
    }
    await fetchBootstrap();
    if (data.appointment) {
      setLastBookedAppointment(data.appointment);
      triggerHighlight(data.appointment.id, data.appointment.slotId, 'booked');
    }
  };

  const handleDownloadToken = useCallback(
    (appointment: Appointment) => {
      const doctor = doctors.find((d) => d.id === appointment.doctorId);
      downloadAppointmentToken(appointment, doctor);
    },
    [doctors]
  );

  const handleCancelAppointment = async (apt: Appointment) => {
    setCancellingId(apt.id);
    try {
      const res = await fetch(`/api/appointments/${encodeURIComponent(apt.id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchBootstrap();
        triggerHighlight(apt.id, apt.slotId, 'cancelled');
      }
    } finally {
      setCancellingId(null);
    }
  };

  const metrics = useMemo(() => {
    const openSlots = slots.filter((s) => !s.isBooked).length;
    const confirmedCount = appointments.filter((a) => a.status === 'Confirmed').length;
    return {
      doctorsCount: doctors.length,
      openSlots,
      confirmedCount,
      callsCount: callLogs.length,
    };
  }, [appointments, callLogs.length, doctors.length, slots]);

  const latestTranscript = useMemo(() => {
    if (transcript.length > 0 || callState === 'ringing' || callState === 'connected') {
      return transcript;
    }
    return callLogs[0]?.transcript || [];
  }, [callLogs, callState, transcript]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900">
      {/* Top Bar Contract: 1 row, 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1380px] items-center justify-between gap-8 px-6 py-3.5">
          {/* Zone 1: Single clean wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 text-left"
          >
            Dr.Connect
          </button>

          {/* Zone 2: 4 concise single-line nav links */}
          <nav
            className="hidden md:flex items-center gap-7 text-sm font-medium"
            aria-label="Primary navigation"
          >
            {(
              [
                ['overview', 'Overview'],
                ['doctors', 'Doctors & Slots'],
                ['appointments', 'Appointments'],
                ['calls', 'Call Logs'],
              ] as const
            ).map(([id, label]) => {
              const active = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`whitespace-nowrap shrink-0 border-b-2 py-1 transition-colors ${
                    active
                      ? 'border-teal-700 text-slate-900'
                      : 'border-transparent text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single primary CTA */}
          <div className="flex items-center shrink-0">
            {callState === 'connected' || callState === 'ringing' ? (
              <button
                type="button"
                onClick={() => {
                  setPhoneOpen(true);
                  setPhoneMinimized(false);
                }}
                className="whitespace-nowrap shrink-0 flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-800"
              >
                <Phone className="h-3.5 w-3.5" />
                <span className="font-mono tabular-nums">
                  {callState === 'ringing'
                    ? 'Connecting...'
                    : `In Call · ${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startVoiceCall()}
                className="whitespace-nowrap shrink-0 flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-800"
              >
                <Phone className="h-3.5 w-3.5" />
                Try Call
              </button>
            )}
          </div>
        </div>

        {/* Mobile Secondary Tab Row */}
        <div className="flex items-center gap-1 overflow-x-auto border-t border-slate-100 px-4 py-2 md:hidden">
          {(
            [
              ['overview', 'Overview'],
              ['doctors', 'Doctors & Slots'],
              ['appointments', 'Appointments'],
              ['calls', 'Call Logs'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`whitespace-nowrap shrink-0 rounded-md px-3 py-1.5 text-xs font-medium ${
                activeTab === id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-[1380px] space-y-6 px-6 py-6">
        {/* KPI Summary Strip */}
        <section
          aria-label="Clinic summary metrics"
          className="grid grid-cols-2 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white sm:grid-cols-4 sm:divide-x sm:divide-y-0"
        >
          <div className="px-5 py-4">
            <p className="text-xs text-slate-500">Active Doctors</p>
            <p className="mt-1 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {loading ? '—' : metrics.doctorsCount}
            </p>
          </div>
          <div className="px-5 py-4">
            <p className="text-xs text-slate-500">Open Slots</p>
            <p className="mt-1 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {loading ? '—' : metrics.openSlots}
            </p>
          </div>
          <div className="px-5 py-4">
            <p className="text-xs text-slate-500">Confirmed Appointments</p>
            <p className="mt-1 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {loading ? '—' : metrics.confirmedCount}
            </p>
          </div>
          <div className="px-5 py-4">
            <p className="text-xs text-slate-500">Calls Handled</p>
            <p className="mt-1 font-display text-2xl font-semibold text-slate-900 tabular-nums">
              {loading ? '—' : metrics.callsCount}
            </p>
          </div>
        </section>

        {loadError && (
          <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-xs text-red-800">
            <span>Unable to sync clinic data: {loadError}</span>
            <button
              type="button"
              onClick={() => void fetchBootstrap()}
              className="font-medium underline"
            >
              Retry
            </button>
          </div>
        )}

        {lastBookedAppointment && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 px-5 py-3 text-xs text-slate-800">
            <div className="flex items-center gap-2.5">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-700" />
              <span>
                Booking confirmed for <strong className="font-semibold">{lastBookedAppointment.patientName}</strong> with{' '}
                <strong className="font-semibold">{lastBookedAppointment.doctorName}</strong> ({lastBookedAppointment.date} · {lastBookedAppointment.time}) — Token{' '}
                <span className="font-mono font-semibold text-teal-900">{lastBookedAppointment.id}</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleDownloadToken(lastBookedAppointment)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-800"
              >
                <Download className="h-3.5 w-3.5" />
                Download Token
              </button>
              <button
                type="button"
                onClick={() => setLastBookedAppointment(null)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-teal-100 hover:text-slate-800"
                aria-label="Dismiss booking banner"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Main Workspace Views */}
        {loading ? (
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white lg:col-span-8" />
            <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-white lg:col-span-4" />
          </div>
        ) : activeTab === 'overview' ? (
          <div className="space-y-6">
            <div className="grid items-start gap-6 lg:grid-cols-12">
              <div className="space-y-6 lg:col-span-8">
                <DoctorsDirectory
                  doctors={doctors}
                  slots={slots}
                  highlightedSlotId={highlightedSlotId}
                  onSelectSlot={(doctor, slot) =>
                    setManualBookingTarget({ doctor, slot })
                  }
                />

                <AppointmentsLedger
                  appointments={appointments}
                  highlightedAppointmentId={highlightedAppointmentId}
                  highlightAction={highlightAction}
                  onCancelAppointment={(apt) => void handleCancelAppointment(apt)}
                  onDownloadToken={handleDownloadToken}
                  cancellingId={cancellingId}
                />
              </div>

              <div className="lg:col-span-4 lg:sticky lg:top-20">
                <LiveTranscriptPanel
                  callState={callState}
                  transcript={latestTranscript}
                  interimTranscript={interimTranscript}
                  capabilities={capabilities}
                  onStartCall={() => void startVoiceCall()}
                />
              </div>
            </div>

            <AnalyticsTrendsSection
              appointments={appointments}
              callLogs={callLogs}
              doctors={doctors}
              slots={slots}
            />
          </div>
        ) : activeTab === 'doctors' ? (
          <DoctorsDirectory
            doctors={doctors}
            slots={slots}
            highlightedSlotId={highlightedSlotId}
            onSelectSlot={(doctor, slot) =>
              setManualBookingTarget({ doctor, slot })
            }
          />
        ) : activeTab === 'appointments' ? (
          <AppointmentsLedger
            appointments={appointments}
            highlightedAppointmentId={highlightedAppointmentId}
            highlightAction={highlightAction}
            onCancelAppointment={(apt) => void handleCancelAppointment(apt)}
            onDownloadToken={handleDownloadToken}
            cancellingId={cancellingId}
          />
        ) : (
          <CallLogsView
            callLogs={callLogs}
            onStartCall={() => void startVoiceCall()}
          />
        )}
      </main>

      {/* Phone-style Call Interface */}
      <PhoneCallOverlay
        open={phoneOpen}
        minimized={phoneMinimized}
        callState={callState}
        agentStatus={agentStatus}
        elapsedSeconds={elapsedSeconds}
        muted={muted}
        speakerMuted={speakerMuted}
        audioLevel={audioLevel}
        audioSource={audioSource}
        transcript={transcript}
        interimTranscript={interimTranscript}
        bookingCard={bookingCard}
        providers={callProviders}
        errorMessage={callError}
        selectedVoice={selectedVoice}
        onVoiceChange={handleVoiceChange}
        onToggleMinimize={() => setPhoneMinimized((m) => !m)}
        onToggleMute={handleToggleMute}
        onToggleSpeaker={() => setSpeakerMuted((s) => !s)}
        onEndCall={endVoiceCall}
        onStartNewCall={() => void startVoiceCall()}
        onCloseOverlay={() => {
          setPhoneOpen(false);
          setPhoneMinimized(false);
        }}
        onSendTextUtterance={handleSendTextUtterance}
        onDownloadToken={handleDownloadToken}
      />

      {/* Direct Desk Booking Modal */}
      <ManualBookingModal
        doctor={manualBookingTarget?.doctor || null}
        slot={manualBookingTarget?.slot || null}
        onClose={() => setManualBookingTarget(null)}
        onConfirm={handleManualBook}
      />
    </div>
  );
}
