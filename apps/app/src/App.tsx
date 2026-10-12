// The app shell: picks the screen from the address after '#'.
// Phase 1 has the role picker and General (holder) mode. Issuer mode is a placeholder until the next phase.
import { useEffect, useState } from 'react';
import { RolePicker, IssuerPlaceholder } from './screens/Start.tsx';
import { Home, CredentialDetail, Claim } from './screens/Home.tsx';
import { Scan } from './screens/Scan.tsx';
import { Present } from './screens/Present.tsx';
import { Activity, Discover, Profile } from './screens/More.tsx';

// Reads the current route, e.g. "#/consent?request_uri=…" => path "/consent" plus its parameters.
function useRoute() {
  const read = () => {
    const [path, query = ''] = window.location.hash.replace(/^#/, '').split('?');
    return { path: path || '/', params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export default function App() {
  const { path, params } = useRoute();
  switch (path) {
    case '/home': return <Home />;
    case '/credential': return <CredentialDetail id={params.get('id') ?? ''} />;
    case '/claim': return <Claim initial={params.get('code') ?? ''} />;
    case '/scan': return <Scan />;
    // key: a new request address starts the consent flow from scratch.
    case '/consent': return <Present key={params.get('request_uri')} requestUri={params.get('request_uri') ?? ''} />;
    case '/activity': return <Activity />;
    case '/discover': return <Discover />;
    case '/profile': return <Profile />;
    case '/issuer': return <IssuerPlaceholder />;
    default: return <RolePicker />;
  }
}
