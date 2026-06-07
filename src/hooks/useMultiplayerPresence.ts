import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export type MultiplayerGridSystemMode = 'grid1' | 'grid2';

export type MultiplayerGridPosition = {
  firstOctet: number;
  secondOctet: number;
  thirdOctet: number;
  fourthOctet: number;
};

export type MultiplayerGrid2Position = {
  outerFirstOctet: number;
  outerSecondOctet: number;
  innerThirdStart: number;
  innerFourthStart: number;
};

export type MultiplayerCell = {
  x: number;
  y: number;
  ipAddress: string;
};

export type MultiplayerPlayerLocation =
  | {
      kind: 'ip';
      ipAddress: string;
      x?: number;
      y?: number;
    }
  | {
      kind: 'intersection';
      x: number;
      y: number;
      ipAddresses: string[];
    };

export type MultiplayerPresence = {
  userId: string;
  displayName: string;
  color: string;
  gridSystemMode: MultiplayerGridSystemMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
  playerLocation?: MultiplayerPlayerLocation;
  pointerTarget?: MultiplayerCell;
  hoveredCell?: MultiplayerCell;
  selectedIp?: string;
  lastSeenAt: string;
};

export type RoomChatMessage = {
  id: string;
  userId: string;
  displayName: string;
  color: string;
  body: string;
  createdAt: string;
};

type UseMultiplayerPresenceInput = {
  roomKey: string;
  gridSystemMode: MultiplayerGridSystemMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
  pointerTarget?: MultiplayerCell;
  playerLocation?: MultiplayerPlayerLocation;
  selectedIp?: string;
};

const USER_ID_KEY = 'cyberspace.userId';
const DISPLAY_NAME_KEY = 'cyberspace.displayName';
const USER_COLOR_KEY = 'cyberspace.userColor';
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be123c', '#65a30d'];

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(key);
}

function writeStorage(key: string, value: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(key, value);
  }
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateIdentity() {
  let userId = readStorage(USER_ID_KEY);
  if (!userId) {
    userId = createId();
    writeStorage(USER_ID_KEY, userId);
  }

  let displayName = readStorage(DISPLAY_NAME_KEY);
  if (!displayName) {
    displayName = `Explorer ${userId.replace(/\D/g, '').slice(-4) || Math.floor(Math.random() * 9000 + 1000)}`;
    writeStorage(DISPLAY_NAME_KEY, displayName);
  }

  let color = readStorage(USER_COLOR_KEY);
  if (!color) {
    color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    writeStorage(USER_COLOR_KEY, color);
  }

  return { userId, displayName, color };
}

function isPresence(value: unknown): value is MultiplayerPresence {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as MultiplayerPresence).userId === 'string' &&
    typeof (value as MultiplayerPresence).displayName === 'string'
  );
}

export function getMultiplayerRoomKey(
  gridSystemMode: MultiplayerGridSystemMode,
  zoomLevel: number,
  currentPosition: MultiplayerGridPosition,
  grid2Position: MultiplayerGrid2Position
): string {
  if (gridSystemMode === 'grid2') {
    return `grid2:outer-${grid2Position.outerFirstOctet}-${grid2Position.outerSecondOctet}:inner-${grid2Position.innerThirdStart}-${grid2Position.innerFourthStart}`;
  }

  if (zoomLevel === 0) return 'grid1:level-0';
  if (zoomLevel === 1) return `grid1:level-1:first-${currentPosition.firstOctet}`;
  if (zoomLevel === 2) return `grid1:level-2:first-${currentPosition.firstOctet}:second-${currentPosition.secondOctet}`;
  return `grid1:level-3:first-${currentPosition.firstOctet}:second-${currentPosition.secondOctet}:third-${currentPosition.thirdOctet}`;
}

export function useMultiplayerPresence({
  roomKey,
  gridSystemMode,
  zoomLevel,
  currentPosition,
  grid2Position,
  pointerTarget,
  playerLocation,
  selectedIp,
}: UseMultiplayerPresenceInput) {
  const identity = useMemo(() => getOrCreateIdentity(), []);
  const [status, setStatus] = useState<'offline' | 'connecting' | 'online' | 'error'>(
    isSupabaseConfigured ? 'connecting' : 'offline'
  );
  const [others, setOthers] = useState<MultiplayerPresence[]>([]);
  const [messages, setMessages] = useState<RoomChatMessage[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastTrackRef = useRef(0);

  const payload = useMemo<MultiplayerPresence>(() => ({
    ...identity,
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    playerLocation,
    pointerTarget,
    hoveredCell: pointerTarget,
    selectedIp,
    lastSeenAt: new Date().toISOString(),
  }), [identity, gridSystemMode, zoomLevel, currentPosition, grid2Position, playerLocation, pointerTarget, selectedIp]);

  useEffect(() => {
    setMessages([]);
    setOthers([]);

    if (!supabase || !isSupabaseConfigured) {
      setStatus('offline');
      return;
    }

    setStatus('connecting');
    const channel = supabase.channel(`cyberspace:${roomKey}`, {
      config: {
        broadcast: { self: false },
        presence: { key: identity.userId },
      },
    });
    channelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, unknown[]>;
        const next = Object.values(state)
          .flat()
          .filter(isPresence)
          .filter((presence) => presence.userId !== identity.userId);
        setOthers(next);
      })
      .on('broadcast', { event: 'chat' }, ({ payload: chatPayload }) => {
        const message = chatPayload as RoomChatMessage;
        if (!message?.id || typeof message.body !== 'string') {
          return;
        }
        setMessages((prev) => [...prev.filter((item) => item.id !== message.id), message].slice(-40));
      })
      .subscribe(async (nextStatus) => {
        if (nextStatus === 'SUBSCRIBED') {
          setStatus('online');
          await channel.track(payload);
          lastTrackRef.current = Date.now();
        } else if (nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT') {
          setStatus('error');
        }
      });

    return () => {
      channelRef.current = null;
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, [roomKey, identity.userId]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || status !== 'online') {
      return;
    }

    const elapsed = Date.now() - lastTrackRef.current;
    const delay = Math.max(0, 500 - elapsed);
    const timer = window.setTimeout(() => {
      void channel.track({ ...payload, lastSeenAt: new Date().toISOString() });
      lastTrackRef.current = Date.now();
    }, delay);

    return () => window.clearTimeout(timer);
  }, [payload, status]);

  const sendMessage = useCallback((body: string) => {
    const trimmed = body.trim().slice(0, 300);
    const channel = channelRef.current;
    if (!trimmed || !channel || status !== 'online') {
      return;
    }

    const message: RoomChatMessage = {
      id: createId(),
      userId: identity.userId,
      displayName: identity.displayName,
      color: identity.color,
      body: trimmed,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, message].slice(-40));
    void channel.send({ type: 'broadcast', event: 'chat', payload: message });
  }, [identity, status]);

  return {
    isConfigured: isSupabaseConfigured,
    status,
    currentUser: identity,
    others,
    messages,
    sendMessage,
  };
}
