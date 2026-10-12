// Issuer console: requests sent by holders from their phones. A staff member with the issuer role approves or rejects.
import { useEffect, useState } from 'react';
import { CREDENTIAL_TYPES } from '@true/shared';
import { Badge, Card, PillButton, Screen, TopBar } from '../ui.tsx';
import { ago, api, can, useApi } from './api.ts';
import { attempt } from './Issuer.tsx';

type InboxItem = {
  ref: string; type: string; pnr: string; status: 'pending' | 'approved' | 'rejected'; createdAt: string; decidedBy: string | null;
  pnrFound: boolean; dobMatches: boolean; studentName: string | null; studentStatus: string | null;
};

export function PendingRequests() {
  const { data, reload } = useApi<{ requests: InboxItem[]; decided: InboxItem[] }>('/v1/requests-inbox');
  const [error, setError] = useState('');
  const mayDecide = can('issue');

  // New requests show up without a manual refresh.
  useEffect(() => {
    const timer = setInterval(reload, 4000);
    return () => clearInterval(timer);
  }, [reload]);

  const decide = async (ref: string, action: 'approve' | 'reject') => {
    setError('');
    await attempt(() => api(`/v1/requests-inbox/${ref}/${action}`, {}), setError);
    reload();
  };

  return (
    <Screen>
      <TopBar back="/issuer/more" title="Pending requests" />
      <Card tone="warn" className="mb-4">
        <p className="text-small"><b>Demo limit:</b> matching a PNR and a date of birth is not identity proofing. A real issuer would check the person before approving.</p>
      </Card>
      {!mayDecide && <Card tone="warn" className="mb-4"><span className="text-small">Only the issuer role (or an admin) can approve or reject. You can view the list.</span></Card>}
      {error && <Card tone="bad" className="mb-4"><span className="text-small text-bad">{error}</span></Card>}

      <div className="space-y-3">
        {data?.requests.length === 0 && <Card><span className="text-small text-muted">No requests are waiting.</span></Card>}
        {data?.requests.map((request) => {
          const matches = request.pnrFound && request.dobMatches;
          return (
            <Card key={request.ref}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">{CREDENTIAL_TYPES[request.type]} · {request.ref}</div>
                  <div className="text-small text-muted">PNR {request.pnr}{request.studentName ? ` · ${request.studentName}` : ''}</div>
                  <div className="text-tiny text-muted">{ago(request.createdAt)}</div>
                </div>
                <Badge tone="warn">Pending</Badge>
              </div>
              {/* What the system checked against the student database. */}
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge tone={request.pnrFound ? 'ok' : 'bad'}>{request.pnrFound ? 'PNR is in the database' : 'PNR not found'}</Badge>
                {request.pnrFound && <Badge tone={request.dobMatches ? 'ok' : 'bad'}>{request.dobMatches ? 'Date of birth matches' : 'Date of birth does NOT match'}</Badge>}
                {request.studentStatus === 'revoked' && <Badge tone="bad">Student is revoked</Badge>}
              </div>
              {mayDecide && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <PillButton kind="secondary" onClick={() => decide(request.ref, 'reject')}>Reject</PillButton>
                  <PillButton disabled={!matches} onClick={() => decide(request.ref, 'approve')}>Approve</PillButton>
                </div>
              )}
              {mayDecide && !matches && <p className="mt-2 text-tiny text-muted">Approve is off because the details do not match the record.</p>}
            </Card>
          );
        })}
      </div>

      {data && data.decided.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 font-semibold">Decided</h2>
          <div className="space-y-2">
            {data.decided.map((request) => (
              <Card key={request.ref}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-small font-semibold">{CREDENTIAL_TYPES[request.type]} · {request.ref}</div>
                    <div className="truncate text-tiny text-muted">PNR {request.pnr}{request.decidedBy ? ` · by ${request.decidedBy}` : ''}</div>
                  </div>
                  <Badge tone={request.status === 'approved' ? 'ok' : 'bad'}>{request.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}
