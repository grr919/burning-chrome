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
      kind: 'building';
      ipAddress: string;
      outside: true;
    };

export type MultiplayerPresence = {
  userId: string;
  sessionId: string;
  displayName: string;
  color: string;
  avatarUrl?: string;
  avatarType?: 'glb' | 'default';
  gridSystemMode: MultiplayerGridSystemMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
  playerLocation?: MultiplayerPlayerLocation;
  pointerTarget?: MultiplayerCell;
  hoveredCell?: MultiplayerCell;
  selectedIp?: string;
  chatLocationKey?: string;
  lastSeenAt: string;
};

export type GridChatMessage = {
  id: string;
  userId: string;
  displayName: string;
  color: string;
  body: string;
  createdAt: string;
  locationKey?: string;
};

type UseMultiplayerPresenceInput = {
  gridKey: string;
  chatLocationKey: string;
  gridSystemMode: MultiplayerGridSystemMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
  pointerTarget?: MultiplayerCell;
  playerLocation?: MultiplayerPlayerLocation;
  selectedIp?: string;
};

const USER_ID_KEY = 'cyberspace.userId';
const SESSION_ID_KEY = 'cyberspace.sessionId';
const DISPLAY_NAME_KEY = 'cyberspace.displayName';
const USER_COLOR_KEY = 'cyberspace.userColor';
const AVATAR_URL_KEY = 'cyberspace.avatarUrl';
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be123c', '#65a30d'];

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(key);
}

function readSessionStorage(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.sessionStorage.getItem(key);
}

function writeStorage(key: string, value: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(key, value);
  }
}

function writeSessionStorage(key: string, value: string): void {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(key, value);
  }
}

function removeStorage(key: string): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(key);
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

  let sessionId = readSessionStorage(SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = createId();
    writeSessionStorage(SESSION_ID_KEY, sessionId);
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

  const avatarUrl = readStorage(AVATAR_URL_KEY)?.trim() || undefined;

  return { userId, sessionId, displayName, color, avatarUrl, avatarType: avatarUrl ? 'glb' as const : 'default' as const };
}

function isPresence(value: unknown): value is MultiplayerPresence {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as MultiplayerPresence).userId === 'string' &&
    typeof (value as MultiplayerPresence).sessionId === 'string' &&
    typeof (value as MultiplayerPresence).displayName === 'string'
  );
}

function dedupePresenceBySessionId(items: MultiplayerPresence[]): MultiplayerPresence[] {
  const bySessionId = new Map<string, MultiplayerPresence>();

  for (const item of items) {
    const previous = bySessionId.get(item.sessionId);
    if (!previous) {
      bySessionId.set(item.sessionId, item);
      continue;
    }

    const previousTime = Date.parse(previous.lastSeenAt || '');
    const nextTime = Date.parse(item.lastSeenAt || '');

    if (!Number.isFinite(previousTime) || (Number.isFinite(nextTime) && nextTime >= previousTime)) {
      bySessionId.set(item.sessionId, item);
    }
  }

  return [...bySessionId.values()];
}

const DEBUG_PRESENCE = false;
const DEBUG_REMOTE_AVATARS = false;

function getPresenceDebugLocation(presence: MultiplayerPresence): string {
  const location = presence.playerLocation;
  if (!location) {
    return presence.selectedIp ?? 'unknown';
  }
  return location.kind === 'building' ? `building:${location.ipAddress}` : `ip:${location.ipAddress}`;
}

function logPresenceDebug(label: string, items: MultiplayerPresence[]) {
  if (!DEBUG_PRESENCE && !DEBUG_REMOTE_AVATARS) {
    return;
  }

  console.info(label, {
    count: items.length,
    records: items.map((presence) => ({
      sessionId: presence.sessionId,
      userId: presence.userId,
      name: presence.displayName,
      location: getPresenceDebugLocation(presence),
      gridMode: presence.gridSystemMode,
      viewMode: presence.playerLocation?.kind ?? 'unknown',
      avatarUrl: Boolean(presence.avatarUrl),
    })),
  });
}

function getChatChannelName(chatLocationKey: string): string {
  const safeKey = encodeURIComponent(chatLocationKey)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 180);
  return `cyberspace-chat:${safeKey || 'unknown'}`;
}

export function getExactLocationKey(location?: MultiplayerPlayerLocation): string {
  if (!location) return 'unknown';
  if (location.kind === 'ip') return `ip:${location.ipAddress}`;
  if (location.kind === 'building') return `building:${location.ipAddress}`;
  return 'unknown';
}

export function getPlayerLocationDisplay(location?: MultiplayerPlayerLocation): string {
  if (!location) return 'Unknown location';
  if (location.kind === 'ip') return location.ipAddress;
  if (location.kind === 'building') return `Building ${location.ipAddress}`;
  return 'Unknown location';
}

export function getMultiplayerGridKey(
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
  gridKey,
  chatLocationKey,
  gridSystemMode,
  zoomLevel,
  currentPosition,
  grid2Position,
  pointerTarget,
  playerLocation,
  selectedIp,
}: UseMultiplayerPresenceInput) {
  const [identity, setIdentity] = useState(() => getOrCreateIdentity());
  const [status, setStatus] = useState<'offline' | 'connecting' | 'online' | 'error'>(
    isSupabaseConfigured ? 'connecting' : 'offline'
  );
  const [chatStatus, setChatStatus] = useState<'unavailable' | 'connecting' | 'ready'>('unavailable');
  const [others, setOthers] = useState<MultiplayerPresence[]>([]);
  const [messages, setMessages] = useState<GridChatMessage[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const chatChannelRef = useRef<RealtimeChannel | null>(null);
  const isChatChannelReadyRef = useRef(false);
  const chatLocationKeyRef = useRef(chatLocationKey);

  useEffect(() => {
    chatLocationKeyRef.current = chatLocationKey;
    setMessages([]);
  }, [chatLocationKey]);

  const payload = useMemo<MultiplayerPresence>(() => ({
    ...identity,
    avatarType: identity.avatarUrl ? 'glb' : 'default',
    gridSystemMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    playerLocation,
    pointerTarget,
    hoveredCell: pointerTarget,
    selectedIp,
    chatLocationKey,
    lastSeenAt: new Date().toISOString(),
  }), [identity, gridSystemMode, zoomLevel, currentPosition, grid2Position, playerLocation, pointerTarget, selectedIp, chatLocationKey]);

  useEffect(() => {
    setMessages([]);
    setOthers([]);
    let isActive = true;

    if (!supabase || !isSupabaseConfigured) {
      setStatus('offline');
      return;
    }

    setStatus('connecting');
    const channel = supabase.channel(`cyberspace:${gridKey}`, {
      config: {
        broadcast: { self: false },
        presence: { key: identity.sessionId },
      },
    });
    channelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        if (!isActive) {
          return;
        }

        const state = channel.presenceState() as Record<string, unknown[]>;
        if (DEBUG_PRESENCE || DEBUG_REMOTE_AVATARS) {
          console.info('DEBUG_PRESENCE raw presence state', state);
        }
        const raw = Object.values(state)
          .flat()
          .filter(isPresence);
        logPresenceDebug('DEBUG_REMOTE_AVATARS raw remote presence records', raw);
        const uniqueBeforeSelfFilter = dedupePresenceBySessionId(raw);
        logPresenceDebug('DEBUG_PRESENCE unique users before self filter', uniqueBeforeSelfFilter);
        const remoteUsers = uniqueBeforeSelfFilter.filter((presence) => presence.sessionId !== identity.sessionId);
        logPresenceDebug('DEBUG_PRESENCE remote users after self filter', remoteUsers);
        setOthers(remoteUsers);
      })
      .subscribe(async (nextStatus) => {
        if (!isActive) {
          return;
        }

        if (nextStatus === 'SUBSCRIBED') {
          setStatus('online');
          await channel.track(payload);
        } else if (nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT') {
          setStatus('error');
        }
      });

    return () => {
      isActive = false;
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, [gridKey, identity.sessionId]);

  useEffect(() => {
    setMessages([]);
    isChatChannelReadyRef.current = false;
    setChatStatus('unavailable');

    if (!supabase || !isSupabaseConfigured || chatLocationKey === 'unknown') {
      return;
    }

    let isActive = true;
    setChatStatus('connecting');
    const chatChannel = supabase.channel(getChatChannelName(chatLocationKey), {
      config: {
        broadcast: { self: false },
      },
    });
    chatChannelRef.current = chatChannel;

    chatChannel
      .on('broadcast', { event: 'chat' }, ({ payload: chatPayload }) => {
        if (!isActive) {
          return;
        }

        const message = chatPayload as GridChatMessage;
        if (!message?.id || typeof message.body !== 'string') {
          return;
        }
        if (message.locationKey !== chatLocationKeyRef.current) {
          return;
        }
        setMessages((prev) => [...prev.filter((item) => item.id !== message.id), message].slice(-40));
      })
      .subscribe((nextStatus) => {
        if (!isActive) {
          return;
        }

        isChatChannelReadyRef.current = nextStatus === 'SUBSCRIBED';
        setChatStatus(nextStatus === 'SUBSCRIBED' ? 'ready' : 'connecting');
      });

    return () => {
      isActive = false;
      isChatChannelReadyRef.current = false;
      setChatStatus('unavailable');
      if (chatChannelRef.current === chatChannel) {
        chatChannelRef.current = null;
      }
      void supabase.removeChannel(chatChannel);
    };
  }, [chatLocationKey]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || status !== 'online') {
      return;
    }

    void channel.track({ ...payload, lastSeenAt: new Date().toISOString() });
  }, [payload, status]);

  const sendMessage = useCallback((body: string) => {
    const trimmed = body.trim().slice(0, 300);
    const chatChannel = chatChannelRef.current;
    if (!trimmed || !chatChannel || !isChatChannelReadyRef.current || status !== 'online' || chatLocationKey === 'unknown') {
      if (trimmed) {
        console.warn('Chat message not sent because exact-location chat is not ready.', { chatLocationKey });
      }
      return false;
    }

    const message: GridChatMessage = {
      id: createId(),
      userId: identity.userId,
      displayName: identity.displayName,
      color: identity.color,
      body: trimmed,
      createdAt: new Date().toISOString(),
      locationKey: chatLocationKey,
    };
    setMessages((prev) => [...prev, message].slice(-40));
    void chatChannel.send({ type: 'broadcast', event: 'chat', payload: message });
    return true;
  }, [chatLocationKey, identity, status]);

  const updateDisplayName = useCallback((nextName: string): boolean => {
    const cleaned = nextName.trim().slice(0, 24);
    if (!cleaned) {
      return false;
    }

    writeStorage(DISPLAY_NAME_KEY, cleaned);
    setIdentity((current) => ({ ...current, displayName: cleaned }));
    return true;
  }, []);

  const updateAvatarUrl = useCallback((avatarUrl: string): boolean => {
    const cleaned = avatarUrl.trim();
    if (!cleaned) {
      return false;
    }

    writeStorage(AVATAR_URL_KEY, cleaned);
    setIdentity((current) => ({ ...current, avatarUrl: cleaned, avatarType: 'glb' }));
    return true;
  }, []);

  const clearAvatar = useCallback((): void => {
    removeStorage(AVATAR_URL_KEY);
    setIdentity((current) => ({ ...current, avatarUrl: undefined, avatarType: 'default' }));
  }, []);

  return {
    isConfigured: isSupabaseConfigured,
    status,
    currentUser: identity,
    currentPresence: payload,
    others,
    messages,
    isChatReady: chatStatus === 'ready',
    chatStatus,
    sendMessage,
    updateDisplayName,
    updateAvatarUrl,
    clearAvatar,
  };
}
