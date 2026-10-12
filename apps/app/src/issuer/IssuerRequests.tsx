// Pending requests from holders. Filled in by Part B of this phase.
import { Card, Screen, TopBar } from '../ui.tsx';

export function PendingRequests() {
  return (
    <Screen>
      <TopBar back="/issuer/more" title="Pending requests" />
      <Card><span className="text-small text-muted">Requests sent by holders will appear here.</span></Card>
    </Screen>
  );
}
