import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { ApiError, applyTheme, getTheme, isAuthError, setToken, takeTokenFromHash } from './api';
import { App } from './App';
import { Router } from './router';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/source-serif-4';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

takeTokenFromHash();
applyTheme(getTheme());

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});
// A token the server no longer accepts sends the app back to sign-in.
client.getQueryCache().subscribe((ev) => {
  if (ev.type === 'updated' && ev.action.type === 'error' && isAuthError(ev.action.error)) {
    setToken(null);
    dispatchEvent(new Event('azhi-signed-out'));
  }
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Router>
      <App />
    </Router>
  </QueryClientProvider>,
);
