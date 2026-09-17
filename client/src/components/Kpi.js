import React from 'react';
export default function Kpi({ label, value, sub, color, dot, glow, onClick, clickable, secondary, delta, unavailable = false }) {
  return (
    <div
      className={`tile kpi ${glow ? 'glow-blue' : ''} col-2 ${clickable ? 'clickable' : ''}`}
      onClick={unavailable ? undefined : onClick}
    >
      <div className="kpi-top">
        <span className="tile-dot" style={{ background: dot }} />
        <span className={`kpi-label ${color}`}>{label}</span>
        {!unavailable && delta !== null && delta !== undefined && (
          <span className={`kpi-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {Math.abs(delta)}%
          </span>
        )}
        {clickable && <span className="kpi-expand">⤢</span>}
      </div>
      <div className="kpi-num">{unavailable ? '—' : value}</div>
      <div className="kpi-sub">{unavailable ? 'Source indisponible' : sub}</div>
      {!unavailable && secondary && (
        <div className="kpi-secondary">
          {(Array.isArray(secondary) ? secondary : [secondary]).map((sec, i) => (
            <span className="kpi-sec-item" key={i}>
              <span className="kpi-sec-dot" style={{ background: sec.dot }} />
              <span className="kpi-sec-val">{sec.value}</span>
              <span className="kpi-sec-label">{sec.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
