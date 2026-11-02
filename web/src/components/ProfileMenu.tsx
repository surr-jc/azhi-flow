import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { applyTheme, getTheme, setToken, type Me, type Theme } from '../api';
import { Icon } from '../icons';
import { Link } from '../router';

const SIZE_KEY = 'azhi-text-size';
// Larger only: the UI never goes below its 13px floor.
const SIZES = [{ id: '1', label: 'Default' }, { id: '1.1', label: 'Large' }, { id: '1.2', label: 'Larger' }] as const;

function getTextSize(): string {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return SIZES.some((s) => s.id === v) ? (v as string) : '1';
  } catch {
    return '1';
  }
}

function applyTextSize(id: string): void {
  if (id === '1') document.documentElement.style.removeProperty('--fs');
  else document.documentElement.style.setProperty('--fs', id);
  try {
    if (id === '1') localStorage.removeItem(SIZE_KEY);
    else localStorage.setItem(SIZE_KEY, id);
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
}

// Runs once when the app loads, so the saved size is in place before the first paint of the shell.
applyTextSize(getTextSize());

const THEME_ICONS: Record<Theme, { label: string; icon: ReactNode }> = {
  system: { label: 'System theme', icon: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></> },
  light: { label: 'Light theme', icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  dark: { label: 'Dark theme', icon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /> },
};

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(getTheme());
  return (
    <div className="seg theme-switch" role="group" aria-label="Theme">
      {(Object.keys(THEME_ICONS) as Theme[]).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} aria-label={THEME_ICONS[t].label} title={THEME_ICONS[t].label} onClick={() => { applyTheme(t); setTheme(t); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{THEME_ICONS[t].icon}</svg>
        </button>
      ))}
    </div>
  );
}

function TextSizeSwitch() {
  const [size, setSize] = useState(getTextSize());
  return (
    <div className="seg" role="group" aria-label="Text size">
      {SIZES.map((s) => (
        <button key={s.id} type="button" aria-pressed={size === s.id} onClick={() => { applyTextSize(s.id); setSize(s.id); }}>{s.label}</button>
      ))}
    </div>
  );
}

// Initials come from the user id; with no id (a run token) the avatar shows a person glyph instead of a guess.
const initials = (id?: string) => (id ? id.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() : '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Avatar({ id, size }: { id?: string; size: number }) {
  const text = initials(id);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {text || <Icon name="person" size={size * 0.55} />}
    </span>
  );
}

/**
 * The account control at the end of the top bar. A button opens a small panel (not a modal) with who
 * is signed in, shortcuts to what needs them, the display preferences that used to sit loose in the bar,
 * and sign out. Escape or a click outside closes it, Tab out of it closes it, and focus returns to the button.
 */
export function ProfileMenu({ me, approvals }: { me?: Me; approvals: number }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const waiting = approvals;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    addEventListener('pointerdown', away);
    addEventListener('keydown', key);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', key); };
  }, [open]);

  const copy = async () => {
    if (!me?.workspaceId) return;
    try {
      await navigator.clipboard.writeText(me.workspaceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the id stays selectable on screen */
    }
  };
  const close = () => setOpen(false);

  return (
    <div className="profile" ref={root} onBlur={(e) => { if (open && !root.current?.contains(e.relatedTarget as Node | null) && e.relatedTarget) setOpen(false); }}>
      <button ref={button} type="button" className="profile-btn" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`Account${me?.role ? `, ${me.role}` : ''}${waiting ? `, ${waiting} waiting` : ''}`} onClick={() => setOpen((o) => !o)}>
        <Avatar id={me?.userId} size={32} />
        <span className="profile-role">{me?.role ? cap(me.role) : 'Account'}</span>
        <Icon name="chevron-down" size={14} className="profile-caret" />
        {waiting ? <span className="profile-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="profile-panel" id={panelId} role="dialog" aria-label="Account">
          <div className="profile-who">
            <Avatar id={me?.userId} size={44} />
            <div className="profile-id">
              <strong title={me?.userId}>{me?.userId ?? 'Signed in'}</strong>
              {me?.role ? <span className="badge">{cap(me.role)}</span> : null}
            </div>
          </div>
          {me?.workspaceId ? (
            <button type="button" className="profile-row ghost" onClick={copy}>
              <Icon name="copy" size={16} />
              <span className="profile-grow"><span className="muted small">Workspace</span><code className="profile-ws">{me.workspaceId}</code></span>
              <span className="muted small" role="status">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          ) : null}
          <div className="profile-sep" />
          <Link to="/ui/approvals" className="profile-row" onClick={close}>
            <Icon name="approval" size={16} /><span className="profile-grow">Approvals</span>
            {approvals ? <span className="count">{approvals}</span> : null}
          </Link>
          <div className="profile-sep" />
          <div className="profile-pref"><span className="muted small">Theme</span><ThemeSwitch /></div>
          <div className="profile-pref"><span className="muted small">Text size</span><TextSizeSwitch /></div>
          <div className="profile-sep" />
          <button type="button" className="profile-row ghost" onClick={() => { setToken(null); dispatchEvent(new Event('azhi-signed-out')); }}>
            <Icon name="signout" size={16} /><span className="profile-grow">Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Approvals waiting on the person, one tap from anywhere. */
export function ApprovalsBell({ count }: { count: number }) {
  return (
    <Link to="/ui/approvals" className="top-icon" aria-label={count ? `Approvals, ${count} waiting` : 'Approvals'} title="Approvals">
      <Icon name="bell" size={20} />
      {count ? <span className="top-icon-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span> : null}
    </Link>
  );
}
