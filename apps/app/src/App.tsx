// The app shell: picks the screen from the address after '#' and from who is logged in.
// Not logged in: welcome, sign up, log in. A PERSON gets the wallet; an INSTITUTION gets its dashboard.
import { useEffect, useState } from 'react';
import { useSession } from './session.ts';
import { Welcome, SignUp, LogIn } from './screens/Auth.tsx';
import { Home, CredentialDetail } from './screens/Wallet.tsx';
import { Offers } from './screens/Offers.tsx';
import { Scan } from './screens/ScanTab.tsx';
import { Present } from './screens/Present.tsx';
import { Activity, Profile } from './screens/Person.tsx';
import { Registers, NewRegister, RegisterCheck } from './screens/Registers.tsx';
import { InstitutionApp } from './institution/Institution.tsx';

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
  const session = useSession();

  if (!session) {
    if (path === '/signup') return <SignUp />;
    if (path === '/login') return <LogIn />;
    return <Welcome />;
  }
  if (session.account.kind === 'institution') return <InstitutionApp path={path} params={params} />;

  switch (path) {
    case '/credential': return <CredentialDetail id={params.get('id') ?? ''} />;
    case '/offers': return <Offers />;
    case '/scan': return <Scan />;
    // key: a new request address starts the consent flow from scratch.
    case '/consent': return <Present key={params.get('request_uri')} requestUri={params.get('request_uri') ?? ''} />;
    case '/activity': return <Activity />;
    case '/registers': return <Registers />;
    case '/register-new': return <NewRegister />;
    case '/register': return <RegisterCheck key={params.get('id')} id={params.get('id') ?? ''} />;
    case '/profile': return <Profile />;
    default: return <Home />;
  }
}
