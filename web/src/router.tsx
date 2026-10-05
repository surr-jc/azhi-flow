import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

// A small path router for /ui/*; the server returns the app for every /ui path.
const Ctx = createContext<{ path: string; search: URLSearchParams; navigate: (to: string) => void }>({ path: '/ui', search: new URLSearchParams(), navigate: () => {} });

export function Router({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, search: location.search });
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const navigate = (to: string) => {
    history.pushState(null, '', to);
    setLoc({ path: location.pathname, search: location.search });
    scrollTo(0, 0);
  };
  return <Ctx.Provider value={{ path: loc.path.replace(/\/$/, '') || '/ui', search: new URLSearchParams(loc.search), navigate }}>{children}</Ctx.Provider>;
}

export const useRoute = () => useContext(Ctx);

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRoute();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Matches `pattern` like /ui/runs/:id against the path; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) out[p[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (p[i] !== a[i]) return null;
  }
  return out;
}
