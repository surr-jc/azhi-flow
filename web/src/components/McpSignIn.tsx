import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api } from '../api';
import { Badge } from '../ui';

/**
 * Signing in to a remote MCP connection happens in a separate window. The window has to be opened while
 * the click that asked for it is still running (browsers block it otherwise), so it is opened empty first
 * and pointed at the provider once the server has built the sign-in URL. The page learns the outcome by
 * polling the connection, not from the window, so the provider's page never gets a handle on this one.
 */
export interface McpStatus { id: string; name: string; url?: string; auth_kind?: 'none' | 'oauth'; status: string; last_error?: string; oauth?: { connected: boolean } }

export function openSignInWindow(): Window | null {
  const win = window.open('', 'azhi-mcp-signin', 'popup,width=520,height=720');
  if (win) win.opener = null;
  return win;
}
/** Points the window at the provider; false when it was blocked or closed, so the caller can show a link. */
export function pointSignIn(win: Window | null, url: string): boolean {
  if (!win || win.closed) return false;
  win.location.href = url;
  return true;
}
export function closeSignIn(win: Window | null) { try { win?.close(); } catch { /* already gone */ } }

export const statusTone = (s: string) => (s === 'ready' ? 'ok' : s === 'error' ? 'bad' : 'warn');
export const statusLabel = (s: string) => (s === 'authorizing' ? 'waiting for sign-in' : s === 'disconnected' ? 'sign in needed' : s);

/** Polls one connection every 2 seconds while a sign-in is pending. */
export function useMcpConnection(id: string | undefined) {
  return useQuery({
    queryKey: ['mcp-connection', id], enabled: Boolean(id),
    queryFn: () => api<McpStatus>(`/v1/mcp/connections/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'authorizing' ? 2000 : false),
  });
}

/** Starts (or restarts) sign-in for an existing connection from a click handler. */
export function useReconnect(onUrl?: (url: string) => void) {
  const qc = useQueryClient();
  const win = useRef<Window | null>(null);
  const start = useMutation({
    mutationFn: (id: string) => api<{ authorization_url: string }>(`/v1/mcp/connections/${id}/oauth/start`, { method: 'POST', body: {} }),
    onSuccess: (r, id) => {
      if (!pointSignIn(win.current, r.authorization_url)) onUrl?.(r.authorization_url);
      void qc.invalidateQueries({ queryKey: ['mcp-connections'] });
      void qc.invalidateQueries({ queryKey: ['mcp-connection', id] });
    },
    onError: () => closeSignIn(win.current),
  });
  return { ...start, reconnect: (id: string) => { win.current = openSignInWindow(); start.mutate(id); } };
}

export function McpStatusBadge({ c }: { c: McpStatus }) {
  return <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>;
}
