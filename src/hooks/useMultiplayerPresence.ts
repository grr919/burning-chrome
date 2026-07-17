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

export type MultiplayerStartingLocationSource = 'default' | 'random' | 'user_preference' | 'last_location';

export type MultiplayerStartingLocation =
  | {
      gridSystemMode: 'grid1';
      source: 'default' | 'user_preference';
      ipAddress: string;
      zoomLevel: number;
      currentPosition: MultiplayerGridPosition;
      x?: number;
      y?: number;
    }
  | {
      gridSystemMode: 'grid2';
      source: 'user_preference';
      ipAddress: string;
      grid2Position: MultiplayerGrid2Position;
      x?: number;
      y?: number;
    }
  | {
      gridSystemMode: 'grid1' | 'grid2';
      source: 'random';
      randomScope: 'grid1' | 'grid2';
    }
  | {
      source: 'last_location';
      lastLocation?: MultiplayerPlayerLocation;
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
  startingLocation?: MultiplayerStartingLocation;
  startingLocationSource?: MultiplayerStartingLocationSource;
  lastLocation?: MultiplayerPlayerLocation;
  lastLocationRecordedAt?: string;
  pointerTarget?: MultiplayerCell;
  hoveredCell?: MultiplayerCell;
  selectedIp?: string;
  locationKey: string;
  chatLocationKey?: string;
  presenceRevision?: number;
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
  gridKey?: string;
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

const USER_ID_KEY = 'cyberspace.userId';
const SESSION_ID_KEY = 'cyberspace.sessionId';
const DISPLAY_NAME_KEY = 'cyberspace.displayName';
const USER_COLOR_KEY = 'cyberspace.userColor';
const AVATAR_URL_KEY = 'cyberspace.avatarUrl';
const AVATAR_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#be123c', '#65a30d'];
const PRESENCE_CHANNEL = 'cyberspace-presence-global';
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

  const presenceId = createId();

  return { userId, sessionId, presenceId, displayName, color, avatarUrl, avatarType: avatarUrl ? 'glb' as const : 'default' as const };
}

function shouldReplacePresenceRecord(previous: MultiplayerPresence, next: MultiplayerPresence): boolean {
  const previousRevision = typeof previous.presenceRevision === 'number' ? previous.presenceRevision : undefined;
  const nextRevision = typeof next.presenceRevision === 'number' ? next.presenceRevision : undefined;
  const previousTime = Date.parse(previous.lastSeenAt || '');
  const nextTime = Date.parse(next.lastSeenAt || '');
  const nextHasAvatar = Boolean(next.avatarUrl);
  const previousHasAvatar = Boolean(previous.avatarUrl);

  if (previousRevision !== undefined || nextRevision !== undefined) {
    if (previousRevision === undefined) {
      return true;
    }
    if (nextRevision === undefined) {
      return false;
    }
    if (nextRevision !== previousRevision) {
      return nextRevision > previousRevision;
    }
  }
  if (!Number.isFinite(previousTime)) {
    return true;
  }
  if (!Number.isFinite(nextTime)) {
    return false;
  }
  if (nextTime !== previousTime) {
    return nextTime > previousTime;
  }
  if (nextHasAvatar !== previousHasAvatar) {
    return nextHasAvatar;
  }
  return Boolean(next.playerLocation || next.selectedIp) && !Boolean(previous.playerLocation || previous.selectedIp);
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

function mergePresenceRecord(
  currentUsers: MultiplayerPresence[],
  incomingPresence: MultiplayerPresence,
  localPresenceId: string,
  source: 'presence-sync' | 'presence-update'
): MultiplayerPresence[] {
  if (incomingPresence.presenceId === localPresenceId) {
    return currentUsers;
  }

  const existingRecord = currentUsers.find((presence) => presence.presenceId === incomingPresence.presenceId);
  const shouldAccept = !existingRecord || shouldReplacePresenceRecord(existingRecord, incomingPresence);

  if (DEBUG_PRESENCE) {
    console.info('DEBUG_PRESENCE remote presence merge', {
      source,
      presenceId: incomingPresence.presenceId,
      name: incomingPresence.displayName,
      accepted: shouldAccept,
      incomingLocationKey: incomingPresence.locationKey,
      incomingPlayerLocation: incomingPresence.playerLocation,
      incomingSelectedIp: incomingPresence.selectedIp,
      incomingPresenceRevision: incomingPresence.presenceRevision,
      incomingLastSeenAt: incomingPresence.lastSeenAt,
      existingLocationKey: existingRecord?.locationKey,
      existingPlayerLocation: existingRecord?.playerLocation,
      existingSelectedIp: existingRecord?.selectedIp,
      existingPresenceRevision: existingRecord?.presenceRevision,
      existingLastSeenAt: existingRecord?.lastSeenAt,
    });
  }

  if (!shouldAccept) {
    return currentUsers;
  }

  return dedupePresenceRecords([
    ...currentUsers.filter((presence) => presence.presenceId !== incomingPresence.presenceId),
    incomingPresence,
  ]).filter((presence) => presence.presenceId !== localPresenceId);
}

function isPresence(value: unknown): value is MultiplayerPresence {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as MultiplayerPresence).userId === 'string' &&
    typeof (value as MultiplayerPresence).sessionId === 'string' &&
    typeof (value as MultiplayerPresence).presenceId === 'string' &&
    typeof (value as MultiplayerPresence).displayName === 'string'
  );
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

function logSinglePresenceDebug(label: string, presence: MultiplayerPresence) {
  if (!DEBUG_PRESENCE && !DEBUG_AVATAR_PIPELINE) {
    return;
  }

  console.info(label, {
    presenceId: presence.presenceId,
    name: presence.displayName,
    playerLocation: presence.playerLocation,
    selectedIp: presence.selectedIp,
    locationKey: presence.locationKey,
    lastSeenAt: presence.lastSeenAt,
    avatarUrl: presence.avatarUrl,
    avatarType: presence.avatarType,
  });
}

function getChatChannelName(chatLocationKey: string): string {
  const safeKey = encodeURIComponent(chatLocationKey)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 180);
  return `cyberspace-chat:${safeKey || 'unknown'}`;
}

function getGridChatChannelName(gridKey: string): string {
  const safeKey = encodeURIComponent(gridKey)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 180);
  return `cyberspace-grid-chat:${safeKey || 'unknown'}`;
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

export function getCanonicalChatLocationKey(location?: MultiplayerPlayerLocation): string {
  if (!location) return 'unknown';
  if (location.kind === 'ip' || location.kind === 'building') return location.ipAddress;
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
  const [shoutStatus, setShoutStatus] = useState<'unavailable' | 'connecting' | 'ready'>('unavailable');
  const [others, setOthers] = useState<MultiplayerPresence[]>([]);
  const [messages, setMessages] = useState<GridChatMessage[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const chatChannelRef = useRef<RealtimeChannel | null>(null);
  const shoutChannelRef = useRef<RealtimeChannel | null>(null);
  const isChatChannelReadyRef = useRef(false);
  const isShoutChannelReadyRef = useRef(false);
  const chatLocationKeyRef = useRef('unknown');
  const gridKeyRef = useRef(gridKey);
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
  const activeChatLocationKey = chatLocationKey;

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

  useEffect(() => {
    gridKeyRef.current = gridKey;
  }, [gridKey]);

  const appendMessage = useCallback((message: GridChatMessage) => {
    setMessages((prev) => [...prev.filter((item) => item.id !== message.id), message].slice(-40));
  }, []);

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
    chatLocationKey: activeChatLocationKey,
    lastSeenAt: new Date().toISOString(),
  }), [identity, gridSystemMode, viewMode, zoomLevel, currentPosition, grid2Position, playerLocation, pointerTarget, selectedIp, locationKey, activeChatLocationKey]);
  const payloadRef = useRef(payload);
  const presenceRevisionRef = useRef(0);
  const pendingPresenceRef = useRef<{
    channel: RealtimeChannel;
    payload: MultiplayerPresence;
    reason: string;
  } | null>(null);
  const isPublishingPresenceRef = useRef(false);
  const authoritativePresenceIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);

  const flushPresencePublish = useCallback(() => {
    if (isPublishingPresenceRef.current) {
      return;
    }

    isPublishingPresenceRef.current = true;
    const run = async () => {
      try {
        while (pendingPresenceRef.current) {
          const pendingPresence = pendingPresenceRef.current;
          pendingPresenceRef.current = null;

          if (channelRef.current !== pendingPresence.channel) {
            continue;
          }

          const fullPayload = {
            ...pendingPresence.payload,
            presenceRevision: presenceRevisionRef.current + 1,
            lastSeenAt: new Date().toISOString(),
          };
          presenceRevisionRef.current = fullPayload.presenceRevision;
          payloadRef.current = fullPayload;
          logSinglePresenceDebug(`DEBUG_PRESENCE local presence publish: ${pendingPresence.reason}`, fullPayload);
          await pendingPresence.channel.track(fullPayload);

          if (channelRef.current !== pendingPresence.channel) {
            continue;
          }

          void pendingPresence.channel.send({
            type: 'broadcast',
            event: 'presence-update',
            payload: fullPayload,
          });
        }
      } finally {
        isPublishingPresenceRef.current = false;
        if (pendingPresenceRef.current) {
          flushPresencePublish();
        }
      }
    };

    void run();
  }, []);

  const publishPresence = useCallback((channel: RealtimeChannel, nextPayload: MultiplayerPresence, reason: string) => {
    pendingPresenceRef.current = { channel, payload: nextPayload, reason };
    flushPresencePublish();
  }, [flushPresencePublish]);

  const syncPresenceUsers = useCallback((rawPresenceRecords: MultiplayerPresence[], localPresenceId: string) => {
    const uniqueBeforeSelfFilter = dedupePresenceRecords(rawPresenceRecords);
    authoritativePresenceIdsRef.current = new Set(uniqueBeforeSelfFilter.map((presence) => presence.presenceId));
    logPresenceDebug('DEBUG_PRESENCE active remote users before self filter', uniqueBeforeSelfFilter);
    const remoteUsers = uniqueBeforeSelfFilter.filter((presence) => presence.presenceId !== localPresenceId);
    logPresenceDebug('DEBUG_PRESENCE active remote users after self filter', remoteUsers);
    setOthers(remoteUsers);
  }, []);

  useEffect(() => {
    setOthers([]);
    authoritativePresenceIdsRef.current = new Set();

    if (!supabase || !isSupabaseConfigured) {
      setStatus('offline');
      return;
    }

    let isActive = true;
    setStatus('connecting');
    const channel = supabase.channel(PRESENCE_CHANNEL, {
      config: {
        broadcast: { self: false },
        presence: { key: identity.presenceId },
      },
    });
    channelRef.current = channel;

    const syncPresenceState = () => {
      if (!isActive) {
        return;
      }

      const state = channel.presenceState() as Record<string, unknown[]>;
      const raw = Object.values(state)
        .flat()
        .filter(isPresence);
      logPresenceDebug('DEBUG_PRESENCE raw global presence records', raw);
      syncPresenceUsers(raw, identity.presenceId);
    };

    channel
      .on('presence', { event: 'sync' }, syncPresenceState)
      .on('presence', { event: 'join' }, syncPresenceState)
      .on('presence', { event: 'leave' }, syncPresenceState)
      .on('broadcast', { event: 'presence-update' }, ({ payload: broadcastPayload }) => {
        if (!isActive || !isPresence(broadcastPayload) || broadcastPayload.presenceId === identity.presenceId) {
          return;
        }
        if (!authoritativePresenceIdsRef.current.has(broadcastPayload.presenceId)) {
          syncPresenceState();
          return;
        }

        logSinglePresenceDebug('DEBUG_PRESENCE received presence-update broadcast', broadcastPayload);
        setOthers((current) => {
          const nextRemoteUsers = mergePresenceRecord(current, broadcastPayload, identity.presenceId, 'presence-update');
          logPresenceDebug('DEBUG_PRESENCE broadcast merge after self filter', nextRemoteUsers);
          return nextRemoteUsers;
        });
      })
      .subscribe(async (nextStatus) => {
        if (!isActive) {
          return;
        }
        if (nextStatus === 'SUBSCRIBED') {
          setStatus('online');
          publishPresence(channel, payloadRef.current, 'subscribe');
        } else if (nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT') {
          setStatus('error');
          authoritativePresenceIdsRef.current = new Set();
          setOthers([]);
        }
      });

    return () => {
      isActive = false;
      pendingPresenceRef.current = null;
      authoritativePresenceIdsRef.current = new Set();
      setOthers([]);
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, [identity.presenceId, publishPresence, syncPresenceUsers]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || status !== 'online') {
      return;
    }

    void publishPresence(channel, payload, 'payload-change');
  }, [payload, publishPresence, status]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || status !== 'online') {
      return;
    }

    const heartbeat = window.setInterval(() => {
      void publishPresence(channel, payloadRef.current, 'heartbeat');
    }, PRESENCE_HEARTBEAT_MS);

    return () => {
      window.clearInterval(heartbeat);
    };
  }, [publishPresence, status]);

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

  useEffect(() => {
    isShoutChannelReadyRef.current = false;
    setShoutStatus('unavailable');

    if (!supabase || !isSupabaseConfigured || !gridKey) {
      return;
    }

    let isActive = true;
    setShoutStatus('connecting');
    const shoutChannel = supabase.channel(getGridChatChannelName(gridKey), {
      config: {
        broadcast: { self: false },
      },
    });
    shoutChannelRef.current = shoutChannel;

    shoutChannel
      .on('broadcast', { event: 'shout' }, ({ payload: shoutPayload }) => {
        if (!isActive) {
          return;
        }

        const message = shoutPayload as GridChatMessage;
        if (!message?.id || typeof message.body !== 'string') {
          return;
        }
        if (message.gridKey !== gridKeyRef.current) {
          return;
        }
        appendMessage(message);
      })
      .subscribe((nextStatus) => {
        if (!isActive) {
          return;
        }

        isShoutChannelReadyRef.current = nextStatus === 'SUBSCRIBED';
        setShoutStatus(nextStatus === 'SUBSCRIBED' ? 'ready' : 'connecting');
      });

    return () => {
      isActive = false;
      isShoutChannelReadyRef.current = false;
      setShoutStatus('unavailable');
      if (shoutChannelRef.current === shoutChannel) {
        shoutChannelRef.current = null;
      }
      void supabase.removeChannel(shoutChannel);
    };
  }, [appendMessage, gridKey]);

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
    appendMessage(message);
    void chatChannel.send({ type: 'broadcast', event: 'chat', payload: message });
    return true;
  }, [activeChatLocationKey, appendMessage, identity, status]);

  const sendShout = useCallback((body: string) => {
    const trimmed = body.trim().slice(0, 300);
    const shoutChannel = shoutChannelRef.current;
    if (!trimmed || !shoutChannel || !isShoutChannelReadyRef.current || status !== 'online' || !gridKey) {
      if (trimmed) {
        console.warn('Shout not sent because grid-scope chat is not ready.', { gridKey });
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
      gridKey,
    };
    appendMessage(message);
    void shoutChannel.send({ type: 'broadcast', event: 'shout', payload: message });
    return true;
  }, [appendMessage, gridKey, identity, status]);

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
    isShoutReady: shoutStatus === 'ready',
    chatStatus,
    sendMessage,
    sendShout,
    updateDisplayName,
    updateAvatarUrl,
    clearAvatar,
  };
}
