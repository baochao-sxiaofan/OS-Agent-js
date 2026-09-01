import {
  Check,
  MonitorUp,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useState } from 'react';

import type {
  HumanCapabilityApprovalView,
} from '../../../shared/contracts.js';

type CapabilityApprovalPanelProps = {
  approvals: HumanCapabilityApprovalView[];
  onResolve: (
    requestId: string,
    decision: 'approve' | 'deny',
  ) => Promise<void>;
};

export function CapabilityApprovalPanel({
  approvals,
  onResolve,
}: CapabilityApprovalPanelProps) {
  const [resolving, setResolving] = useState(false);
  const approval = approvals[0];
  if (!approval) {
    return null;
  }

  const resolve = async (decision: 'approve' | 'deny') => {
    if (resolving) {
      return;
    }
    setResolving(true);
    try {
      await onResolve(approval.requestId, decision);
    } finally {
      setResolving(false);
    }
  };

  const capturesScreen = approval.requests.some(
    (request) => request.capability === 'screen.capture',
  );

  return (
    <section
      className="capability-approval"
      role="dialog"
      aria-modal="true"
      aria-labelledby="capability-approval-title"
    >
      <header>
        <span>
          {capturesScreen ? (
            <MonitorUp size={17} />
          ) : (
            <ShieldAlert size={17} />
          )}
        </span>
        <div>
          <small>HUMAN APPROVAL</small>
          <strong id="capability-approval-title">权限申请</strong>
        </div>
        {approvals.length > 1 && (
          <em>{approvals.length} 项待处理</em>
        )}
      </header>
      <p>{approval.requesterGoal}</p>
      <dl>
        {approval.requests.map((request) => (
          <div key={`${request.capability}:${request.scope}`}>
            <dt>{request.capability}</dt>
            <dd>{request.scope}</dd>
          </div>
        ))}
      </dl>
      <footer>
        <button
          type="button"
          disabled={resolving}
          onClick={() => void resolve('deny')}
        >
          <X size={15} />
          拒绝
        </button>
        <button
          className="capability-approval__approve"
          type="button"
          disabled={resolving}
          onClick={() => void resolve('approve')}
        >
          <Check size={15} />
          单次允许
        </button>
      </footer>
    </section>
  );
}
