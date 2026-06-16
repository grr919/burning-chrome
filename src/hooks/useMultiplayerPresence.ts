import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export type MultiplayerGridSystemMode = 'grid1' | 'grid2';
export type MultiplayerViewMode = 'grid' | 'street' | 'building';

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
  presenceId: string;
  displayName: string;
  color: string;
  avatarUrl?: string;
  avatarType?: 'glb' | 'default';
  gridSystemMode: MultiplayerGridSystemMode;
  viewMode: MultiplayerViewMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
  playerLocation?: MultiplayerPlayerLocation;
  pointerTarget?: MultiplayerCell;
  hoveredCell?: MultiplayerCell;
  selectedIp?: string;
  locationKey: string;
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
  viewMode: MultiplayerViewMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
  pointerTarget?: MultiplayerCell;
  playerLocation?: MultiplayerPlayerLocation;
  selectedIp?: string;
};

export type MultiplayerLocationContext = {
  gridSystemMode: MultiplayerGridSystemMode;
  viewMode: MultiplayerViewMode;
  zoomLevel: number;
  currentPosition: MultiplayerGridPosition;
  grid2Position: MultiplayerGrid2Position;
};

type MultiplayerPresenceRow = {
  presence_id: string;
  session_id: string;
  user_id: string;
  display_name: string;
  color: string;
  avatar_url: string | null;
  avatar_type: 'glb' | 'default' | null;
  location_key: string;
  grid_system_mode: MultiplayerGridSystemMode;
  view_mode: MultiplayerViewMode;
  zoom_level: number;
  current_position: MultiplayerGridPosition;
  grid2_position: MultiplayerGrid2Position;
  player_location: MultiplayerPlayerLocation | null;
  pointer_target: MultiplayerCell | null;
  hovered_cell: MultiplayerCell | null;
  selected_ip: string | null;
  chat_location_key: string | null;
  last_seen: string;
};

const USER_ID_KEY = 'cyberspace.userId';
const SESSION_ID_KEY = 'cyberspace.sessionId';
const PRESENCE_ID_KEY = 'cyberspace.presenceId';
const DISPLAY_NAME_KEY = 'cyberspace.displayName';
const USER_COLOR_KEY = 'cyberspace.userColor';
const AVATAR_URL_KEY = 'cyberspace.avatarUrl';
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be123c', '#65a30d'];
const PRESENCE_TABLE = 'multiplayer_presence';
const PRESENCE_STALE_MS = 45_000;
const PRESENCE_HEARTBEAT_MS = 15_000;

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

function getAvatarUrlDebugInfo(avatarUrl?: string) {
  const value = avatarUrl?.trim() ?? '';
  const lowerValue = value.toLowerCase();
  return {
    avatarUrlExists: Boolean(value),
    avatarUrl: value,
    startsWithHttp: /^https?:\/\//i.test(value),
    startsWithBlob: lowerValue.startsWith('blob:'),
    startsWithFile: lowerValue.startsWith('file:'),
    startsWithLocalhost:
      lowerValue.includes('localhost') ||
      lowerValue.includes('127.0.0.1') ||
      lowerValue.includes('[::1]'),
  };
}

function isPublishableAvatarUrl(avatarUrl: string): boolean {
  const info = getAvatarUrlDebugInfo(avatarUrl);
  return info.startsWithHttp && !info.startsWithBlob && !info.startsWithFile && !info.startsWithLocalhost;
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

  const savedAvatarUrl = readStorage(AVATAR_URL_KEY)?.trim() || undefined;
  const avatarUrl = savedAvatarUrl && isPublishableAvatarUrl(savedAvatarUrl) ? savedAvatarUrl : undefined;
  if (savedAvatarUrl && !avatarUrl) {
    removeStorage(AVATAR_URL_KEY);
  }

  let presenceId = readSessionStorage(PRESENCE_ID_KEY);
  if (!presenceId) {
    presenceId = createId();
    writeSessionStorage(PRESENCE_ID_KEY, presenceId);
  }

  return { userId, sessionId, presenceId, displayName, color, avatarUrl, avatarType: avatarUrl ? 'glb' as const : 'default' as const };
}

function shouldReplacePresenceRecord(previous: MultiplayerPresence, next: MultiplayerPresence): boolean {
  const previousTime = Date.parse(previous.lastSeenAt || '');
  const nextTime = Date.parse(next.lastSeenAt || '');
  const nextHasAvatar = Boolean(next.avatarUrl);
  const previousHasAvatar = Boolean(previous.avatarUrl);

  return (
    (nextHasAvatar && !previousHasAvatar) ||
    !Number.isFinite(previousTime) ||
    (Number.isFinite(nextTime) && nextTime >= previousTime)
  );
}

function dedupePresenceRecords(items: MultiplayerPresence[]): MultiplayerPresence[] {
  const byPresenceKey = new Map<string, MultiplayerPresence>();

  for (const item of items) {
    const key = item.presenceId || `session:${item.sessionId}`;
    const previous = byPresenceKey.get(key);
    if (!previous) {
      byPresenceKey.set(key, item);
      continue;
    }

    if (shouldReplacePresenceRecord(previous, item)) {
      byPresenceKey.set(key, item);
    }
  }

  return [...byPresenceKey.values()];
}

function isPresenceFresh(presence: MultiplayerPresence, now = Date.now()): boolean {
  const lastSeen = Date.parse(presence.lastSeenAt || '');
  return Number.isFinite(lastSeen) && now - lastSeen <= PRESENCE_STALE_MS;
}

function toPresenceRow(presence: MultiplayerPresence): MultiplayerPresenceRow {
  return {
    presence_id: presence.presenceId,
    session_id: presence.sessionId,
    user_id: presence.userId,
    display_name: presence.displayName,
    color: presence.color,
    avatar_url: presence.avatarUrl ?? null,
    avatar_type: presence.avatarType ?? 'default',
    location_key: presence.locationKey,
    grid_system_mode: presence.gridSystemMode,
    view_mode: presence.viewMode,
    zoom_level: presence.zoomLevel,
    current_position: presence.currentPosition,
    grid2_position: presence.grid2Position,
    player_location: presence.playerLocation ?? null,
    pointer_target: presence.pointerTarget ?? null,
    hovered_cell: presence.hoveredCell ?? null,
    selected_ip: presence.selectedIp ?? null,
    chat_location_key: presence.chatLocationKey ?? null,
    last_seen: presence.lastSeenAt,
  };
}

function rowToPresence(row: MultiplayerPresenceRow): MultiplayerPresence {
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    presenceId: row.presence_id,
    displayName: row.display_name,
    color: row.color,
    avatarUrl: row.avatar_url ?? undefined,
    avatarType: row.avatar_type ?? (row.avatar_url ? 'glb' : 'default'),
    gridSystemMode: row.grid_system_mode,
    viewMode: row.view_mode,
    zoomLevel: row.zoom_level,
    currentPosition: row.current_position,
    grid2Position: row.grid2_position,
    playerLocation: row.player_location ?? undefined,
    pointerTarget: row.pointer_target ?? undefined,
    hoveredCell: row.hovered_cell ?? undefined,
    selectedIp: row.selected_ip ?? undefined,
    locationKey: row.location_key,
    chatLocationKey: row.chat_location_key ?? undefined,
    lastSeenAt: row.last_seen,
  };
}

const DEBUG_PRESENCE = false;
const DEBUG_REMOTE_AVATARS = false;
const DEBUG_AVATAR_PIPELINE = false;

function getPresenceDebugLocation(presence: MultiplayerPresence): string {
  const location = presence.playerLocation;
  if (!location) {
    return presence.selectedIp ?? 'unknown';
  }
  return location.kind === 'building' ? `building:${location.ipAddress}` : `ip:${location.ipAddress}`;
}

function logPresenceDebug(label: string, items: MultiplayerPresence[]) {
  if (!DEBUG_PRESENCE && !DEBUG_REMOTE_AVATARS && !DEBUG_AVATAR_PIPELINE) {
    return;
  }

  console.info(label, {
    count: items.length,
    records: items.map((presence) => ({
      presenceId: presence.presenceId,
      sessionId: presence.sessionId,
      userId: presence.userId,
      name: presence.displayName,
      location: getPresenceDebugLocation(presence),
      gridMode: presence.gridSystemMode,
      viewMode: presence.viewMode,
      ...getAvatarUrlDebugInfo(presence.avatarUrl),
    })),
  });
}

function getChatChannelName(chatLocationKey: string): string {
  const safeKey = encodeURIComponent(chatLocationKey)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 180);
  return `cyberspace-chat:${safeKey || 'unknown'}`;
}

export function getExactLocationKey(location?: MultiplayerPlayerLocation, context?: MultiplayerLocationContext): string {
  if (!location) return 'unknown';
  const gridKey = context
    ? `${context.viewMode}:${getMultiplayerGridKey(context.gridSystemMode, context.zoomLevel, context.currentPosition, context.grid2Position)}:`
    : '';
  if (location.kind === 'ip') {
    const coordinates =
      typeof location.x === 'number' && typeof location.y === 'number'
        ? `:cell-${location.x}-${location.y}`
        : '';
    return `${gridKey}ip:${location.ipAddress}${coordinates}`;
  }
  if (location.kind === 'building') return `${gridKey}building:${location.ipAddress}:outside`;
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
  gridSystemMode,
  viewMode,
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
  const chatLocationKeyRef = useRef('unknown');
  const locationContext = useMemo<MultiplayerLocationContext>(() => ({
    gridSystemMode,
    viewMode,
    zoomLevel,
    currentPosition,
    grid2Position,
  }), [gridSystemMode, viewMode, zoomLevel, currentPosition, grid2Position]);
  const locationKey = useMemo(
    () => getExactLocationKey(playerLocation, locationContext),
    [playerLocation, locationContext]
  );
  const activeChatLocationKey = locationKey;

  useEffect(() => {
    if (!DEBUG_AVATAR_PIPELINE) {
      return;
    }
    console.info('DEBUG_AVATAR_PIPELINE local identity', {
      presenceId: identity.presenceId,
      sessionId: identity.sessionId,
      userId: identity.userId,
      name: identity.displayName,
      avatarType: identity.avatarType,
      ...getAvatarUrlDebugInfo(identity.avatarUrl),
    });
  }, [identity]);

  useEffect(() => {
    chatLocationKeyRef.current = activeChatLocationKey;
    setMessages([]);
  }, [activeChatLocationKey]);

  const payload = useMemo<MultiplayerPresence>(() => ({
    ...identity,
    avatarType: identity.avatarUrl ? 'glb' : 'default',
    gridSystemMode,
    viewMode,
    zoomLevel,
    currentPosition,
    grid2Position,
    playerLocation,
    pointerTarget,
    hoveredCell: pointerTarget,
    selectedIp,
    locationKey,
    chatLocationKey: locationKey,
    lastSeenAt: new Date().toISOString(),
  }), [identity, gridSystemMode, viewMode, zoomLevel, currentPosition, grid2Position, playerLocation, pointerTarget, selectedIp, locationKey]);
  const payloadRef = useRef(payload);

  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);

  const readActivePresence = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    const cutoff = new Date(Date.now() - PRESENCE_STALE_MS).toISOString();
    const { data, error } = await supabase
      .from(PRESENCE_TABLE)
      .select('*')
      .gt('last_seen', cutoff)
      .order('last_seen', { ascending: false });

    if (error) {
      console.warn('Unable to read multiplayer presence records.', error);
      setStatus('error');
      return;
    }

    const remoteUsers = dedupePresenceRecords(((data ?? []) as MultiplayerPresenceRow[])
      .map(rowToPresence)
      .filter((presence) =>
        isPresenceFresh(presence) &&
        (presence.presenceId
          ? presence.presenceId !== identity.presenceId
          : presence.sessionId !== identity.sessionId)
      ));
    logPresenceDebug('DEBUG_PRESENCE authoritative remote records', remoteUsers);
    setOthers(remoteUsers);
  }, [identity.presenceId, identity.sessionId]);

  const upsertPresence = useCallback(async (nextPresence: MultiplayerPresence) => {
    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    const currentPresence = {
      ...nextPresence,
      locationKey: nextPresence.locationKey || getExactLocationKey(nextPresence.playerLocation, {
        gridSystemMode: nextPresence.gridSystemMode,
        viewMode: nextPresence.viewMode,
        zoomLevel: nextPresence.zoomLevel,
        currentPosition: nextPresence.currentPosition,
        grid2Position: nextPresence.grid2Position,
      }),
      chatLocationKey: nextPresence.locationKey || nextPresence.chatLocationKey,
      lastSeenAt: new Date().toISOString(),
    };

    const { error } = await supabase
      .from(PRESENCE_TABLE)
      .upsert(toPresenceRow(currentPresence), { onConflict: 'presence_id' });

    if (error) {
      console.warn('Unable to publish multiplayer presence record.', error);
      setStatus('error');
      return;
    }

    if (DEBUG_PRESENCE) {
      console.info('DEBUG_PRESENCE upserted authoritative presence', {
        presenceId: currentPresence.presenceId,
        locationKey: currentPresence.locationKey,
        displayName: currentPresence.displayName,
      });
    }
  }, []);

  useEffect(() => {
    setOthers([]);

    if (!supabase || !isSupabaseConfigured) {
      setStatus('offline');
      return;
    }

    let isActive = true;
    setStatus('connecting');
    void readActivePresence();

    const channel = supabase
      .channel('cyberspace-presence-records')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: PRESENCE_TABLE },
        () => {
          if (isActive) {
            void readActivePresence();
          }
        }
      )
      .subscribe((nextStatus) => {
        if (!isActive) {
          return;
        }
        if (nextStatus === 'SUBSCRIBED') {
          setStatus('online');
          void readActivePresence();
        } else if (nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT') {
          setStatus('error');
        }
      });
    channelRef.current = channel;

    return () => {
      isActive = false;
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [readActivePresence]);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    void upsertPresence(payload);
  }, [payload, upsertPresence]);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    const heartbeat = window.setInterval(() => {
      void upsertPresence(payloadRef.current);
      void readActivePresence();
    }, PRESENCE_HEARTBEAT_MS);

    const deletePresence = () => {
      void supabase
        .from(PRESENCE_TABLE)
        .delete()
        .eq('presence_id', identity.presenceId);
    };

    window.addEventListener('pagehide', deletePresence);
    window.addEventListener('beforeunload', deletePresence);

    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('pagehide', deletePresence);
      window.removeEventListener('beforeunload', deletePresence);
      deletePresence();
    };
  }, [identity.presenceId, readActivePresence, upsertPresence]);

  useEffect(() => {
    setMessages([]);
    isChatChannelReadyRef.current = false;
    setChatStatus('unavailable');

    if (!supabase || !isSupabaseConfigured || activeChatLocationKey === 'unknown') {
      return;
    }

    let isActive = true;
    setChatStatus('connecting');
    const chatChannel = supabase.channel(getChatChannelName(activeChatLocationKey), {
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
  }, [activeChatLocationKey]);

  const sendMessage = useCallback((body: string) => {
    const trimmed = body.trim().slice(0, 300);
    const chatChannel = chatChannelRef.current;
    if (!trimmed || !chatChannel || !isChatChannelReadyRef.current || status !== 'online' || activeChatLocationKey === 'unknown') {
      if (trimmed) {
        console.warn('Chat message not sent because exact-location chat is not ready.', { chatLocationKey: activeChatLocationKey });
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
      locationKey: activeChatLocationKey,
    };
    setMessages((prev) => [...prev, message].slice(-40));
    void chatChannel.send({ type: 'broadcast', event: 'chat', payload: message });
    return true;
  }, [activeChatLocationKey, identity, status]);

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
    if (!isPublishableAvatarUrl(cleaned)) {
      console.warn('Rejected non-public avatar URL for presence', getAvatarUrlDebugInfo(cleaned));
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
