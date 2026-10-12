// The app shell: picks the screen from the address after '#'.
// The role picker leads to General (holder) mode or to the issuer console.
import { useEffect, useState } from 'react';
import { RolePicker } from './screens/Start.tsx';
import { IssuerApp } from './issuer/Issuer.tsx';
import { Home, CredentialDetail, Claim } from './screens/Home.tsx';
import { Scan } from './screens/Scan.tsx';
import { Present } from './screens/Present.tsx';
import { Activity, Discover, Profile } from './screens/More.tsx';
import { Requests, checkMyRequests } from './screens/Requests.tsx';

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
  const holderMode = path !== '/' && !path.startsWith('/issuer');

  // In holder mode, check on pending requests every 4 seconds wherever the holder is in the app,
  // so an approved credential is collected without having to sit on the Requests tab.
  useEffect(() => {
    if (!holderMode) return;
    const timer = setInterval(() => checkMyRequests().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [holderMode]);

  switch (path) {
    case '/home': return <Home />;
    case '/credential': return <CredentialDetail id={params.get('id') ?? ''} />;
    case '/claim': return <Claim initial={params.get('code') ?? ''} />;
    case '/scan': return <Scan />;
    // key: a new request address starts the consent flow from scratch.
    case '/consent': return <Present key={params.get('request_uri')} requestUri={params.get('request_uri') ?? ''} />;
    case '/requests': return <Requests />;
    case '/activity': return <Activity />;
    case '/discover': return <Discover />;
    case '/profile': return <Profile />;
    default:
      // Everything under /issuer is the issuer console (staff PIN first).
      return path.startsWith('/issuer') ? <IssuerApp path={path} params={params} /> : <RolePicker />;
  }
}
