type AgentCapacityMeterProps = {
  available: number;
  limit: number;
};

export function AgentCapacityMeter({
  available,
  limit,
}: AgentCapacityMeterProps) {
  const safeLimit = Math.max(1, limit);
  const percentage = Math.max(
    0,
    Math.min(100, (available / safeLimit) * 100),
  );
  const level =
    percentage <= 20 ? 'low' : percentage <= 50 ? 'medium' : 'high';

  return (
    <div
      className={`agent-capacity agent-capacity--${level}`}
      title={`剩余 Agent 槽位 ${available}/${limit}`}
      aria-label={`剩余 Agent 槽位 ${available}/${limit}`}
    >
      <div className="agent-capacity__battery" aria-hidden="true">
        <span style={{ width: `${percentage}%` }} />
      </div>
      <div className="agent-capacity__copy">
        <span>可用 Agent</span>
        <strong>
          {available}
          <small>/{limit}</small>
        </strong>
      </div>
    </div>
  );
}
