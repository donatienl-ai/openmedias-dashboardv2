import React, { useState, useEffect, useCallback } from 'react';

// Formatage nombre type "159 280" (espace comme séparateur de milliers)
function fmt(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
}

// Date du jour en français : "lundi 02 juin 2026"
function todayLabel() {
  return new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ============ LOGIN ============
function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onSuccess(password);
      } else {
        setError('Mot de passe incorrect');
      }
    } catch (e) {
      setError('Erreur de connexion au serveur');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-eyebrow">OpenMedias · Sales Dashboard</div>
        <div className="login-title">Performance<br />Commerciale</div>
        <input
          className="login-input"
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
        <button className="login-btn" onClick={submit} disabled={loading}>
          {loading ? 'Connexion…' : 'Accéder au dashboard'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}

// ============ TABLEAU DÉTAIL ============
function DetailTable({ columns, rows, valueKey = 'count', isAmount = false, totalLabel, totalValue, accentClass }) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{columns[0]}</th>
          <th className="right">{columns[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={2} className="empty-row">Aucune donnée aujourd'hui</td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr key={i}>
              <td>{r.name}</td>
              <td className="right">
                <span className={accentClass}>
                  {isAmount ? `${fmt(r.amount)} €` : r[valueKey]}
                </span>
              </td>
            </tr>
          ))
        )}
        {totalLabel && (
          <tr className="total-row">
            <td>{totalLabel}</td>
            <td className="right"><span className={accentClass}>{totalValue}</span></td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ============ DASHBOARD ============
function Dashboard({ password, onLogout }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/dashboard', {
        headers: { 'x-dashboard-password': password },
      });
      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) throw new Error('Erreur serveur');
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [password, onLogout]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div className="dash">
        <div className="loading-wrap">
          <div className="spinner" />
          <div>Chargement des données…</div>
        </div>
      </div>
    );
  }

  const d = data || {};
  const rdvT = d.rdvToday || { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } };
  const rdvB = d.rdvBooked || { r1: { total: 0, detail: [] }, r2: { total: 0, detail: [] } };
  const sig = d.signatures || { total: 0, totalAmount: 0, detail: [] };
  const rev = d.revenue || { totalAmount: 0, detail: [] };
  const propals = d.propals || { total: 0, detail: [] };
  const calls = d.calls || { total: 0, detail: [] };
  const sf = d.salesforge || { total: 0, detail: [] };

  return (
    <div className="dash">
      {/* HEADER */}
      <div className="dash-header">
        <div className="dash-header-row">
          <div>
            <div className="dash-eyebrow">OpenMedias · Sales Dashboard</div>
            <div className="dash-title">Performance Commerciale</div>
            <div className="dash-date">{todayLabel()}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <button
              className={`refresh-btn ${loading ? 'loading' : ''}`}
              onClick={load}
              disabled={loading}
            >
              <span className="refresh-icon">↻</span>
              {loading ? 'Actualisation…' : 'Rafraîchir'}
            </button>
            {d.generatedAt && <div className="updated-at">MAJ : {timeLabel(d.generatedAt)}</div>}
          </div>
        </div>
      </div>

      {/* RANGÉE 1 - Activité */}
      <div className="kpi-zone">
        <div className="kpi-zone-label">Activité du jour</div>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label c-blue">Calls</div>
            <div className="kpi-value">{calls.total}</div>
            <div className="kpi-sub">passés</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label c-green">R1</div>
            <div className="kpi-value">{rdvT.r1.total}</div>
            <div className="kpi-sub">échanges</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label c-bluer2">R2</div>
            <div className="kpi-value">{rdvT.r2.total}</div>
            <div className="kpi-sub">retours</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label c-amber">R1 Pris</div>
            <div className="kpi-value">{rdvB.r1.total}</div>
            <div className="kpi-sub">bookés</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label c-amber">R2 Pris</div>
            <div className="kpi-value">{rdvB.r2.total}</div>
            <div className="kpi-sub">bookés</div>
          </div>
        </div>
      </div>

      {/* RANGÉE 2 - Résultats */}
      <div className="kpi-zone">
        <div className="kpi-zone-label">Résultats du jour</div>
        <div className="kpi-grid two">
          <div className="kpi-card big">
            <div className="kpi-label c-orange">Propals</div>
            <div className="kpi-value">{propals.total}</div>
            <div className="kpi-sub">envoyées aujourd'hui</div>
          </div>
          <div className="kpi-card big accent">
            <div className="kpi-label c-violet">Signatures</div>
            <div className="kpi-value">{sig.total}</div>
            <div className="kpi-sub">du jour</div>
          </div>
        </div>
      </div>

      {/* BIG CA */}
      <div className="ca-zone">
        <div className="ca-card">
          <div>
            <div className="ca-card-label">💰 CA réalisé · ce mois</div>
            <div className="ca-card-sub">Cumul des deals signés depuis le 1er du mois</div>
          </div>
          <div className="ca-card-value">{fmt(rev.totalAmount)} €</div>
        </div>
      </div>

      {/* ERREURS PARTIELLES */}
      {(error || d.errors) && (
        <div className="section" style={{ paddingBottom: 0 }}>
          {error && <div className="err-banner"><strong>Erreur :</strong> {error}</div>}
          {d.errors &&
            Object.entries(d.errors).map(([k, v]) => (
              <div className="err-banner" key={k}>
                <strong>{k} :</strong> {v}
              </div>
            ))}
        </div>
      )}

      {/* CALLS */}
      <div className="section">
        <span className="badge badge-blue">📞 Calls passés</span>
        <DetailTable
          columns={['Commercial', 'Calls']}
          rows={calls.detail}
          accentClass="c-blue"
          totalLabel="Total équipe"
          totalValue={calls.total}
        />
      </div>

      {/* R1 / R2 DU JOUR */}
      <div className="section">
        <div className="section-cols">
          <div>
            <span className="badge badge-green">🟢 R1 — Échanges du jour</span>
            <DetailTable columns={['Commercial', 'RDV']} rows={rdvT.r1.detail} accentClass="c-green" />
          </div>
          <div>
            <span className="badge badge-bluer2">🔵 R2 — Retours du jour</span>
            <DetailTable columns={['Commercial', 'RDV']} rows={rdvT.r2.detail} accentClass="c-bluer2" />
          </div>
        </div>
      </div>

      {/* R1 / R2 PRIS */}
      <div className="section">
        <div className="section-cols">
          <div>
            <span className="badge badge-amber">📅 R1 pris aujourd'hui</span>
            <DetailTable columns={['Commercial', 'Bookés']} rows={rdvB.r1.detail} accentClass="c-amber" />
          </div>
          <div>
            <span className="badge badge-amber">📅 R2 pris aujourd'hui</span>
            <DetailTable columns={['Commercial', 'Bookés']} rows={rdvB.r2.detail} accentClass="c-amber" />
          </div>
        </div>
      </div>

      {/* PROPALS */}
      <div className="section">
        <span className="badge badge-orange">📤 Propals envoyées aujourd'hui</span>
        <DetailTable
          columns={['Commercial', 'Propals']}
          rows={propals.detail}
          accentClass="c-orange"
          totalLabel="Total équipe"
          totalValue={propals.total}
        />
      </div>

      {/* SIGNATURES */}
      <div className="section">
        <span className="badge badge-blue">✅ Signatures du jour</span>
        {sig.detail.length === 0 ? (
          <div className="sig-empty">Aucune signature aujourd'hui</div>
        ) : (
          <div className="sig-card">
            {sig.detail.map((s, i) => (
              <div className="sig-line" key={i}>
                <span className="name">{s.name}</span>
                <span className="val">{s.count} signature(s) · {fmt(s.amount)} €</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* CA MOIS DÉTAIL */}
      <div className="section">
        <span className="badge badge-blue">💰 CA du mois — détail par sales</span>
        <DetailTable
          columns={['Commercial', 'CA']}
          rows={rev.detail}
          isAmount
          accentClass="c-blue"
          totalLabel="Total équipe"
          totalValue={`${fmt(rev.totalAmount)} €`}
        />
      </div>

      {/* SALESFORGE */}
      <div className="section">
        <span className="badge badge-bluer2">📧 RDV via SalesForge — cumul</span>
        <DetailTable
          columns={['Commercial', 'RDV']}
          rows={sf.detail}
          accentClass="c-bluer2"
          totalLabel="Total SalesForge"
          totalValue={sf.total}
        />
      </div>

      {/* FOOTER */}
      <div className="dash-footer">
        <div>
          <div className="footer-brand">OPENMEDIAS</div>
          <div className="footer-sub">
            Dashboard temps réel · Aircall + Calendly + Salesforce<br />
            OpenMedias Growth · {new Date().getFullYear()}
          </div>
        </div>
        <div className="footer-tag">Live</div>
      </div>
    </div>
  );
}

// ============ APP ROOT ============
export default function App() {
  const [password, setPassword] = useState(null);

  // On retient le mot de passe en sessionStorage pour ne pas le redemander à chaque reload
  useEffect(() => {
    const saved = sessionStorage.getItem('om_pw');
    if (saved) setPassword(saved);
  }, []);

  const handleSuccess = (pw) => {
    sessionStorage.setItem('om_pw', pw);
    setPassword(pw);
  };
  const handleLogout = () => {
    sessionStorage.removeItem('om_pw');
    setPassword(null);
  };

  if (!password) return <Login onSuccess={handleSuccess} />;
  return <Dashboard password={password} onLogout={handleLogout} />;
}
