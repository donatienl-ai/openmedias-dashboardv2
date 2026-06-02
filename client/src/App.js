import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from 'recharts';

// ---------- helpers ----------
function fmt(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
}
function todayLabel() {
  return new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
}
function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ---------- LOGIN ----------
function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) onSuccess(password);
      else setError('Mot de passe incorrect');
    } catch {
      setError('Erreur de connexion au serveur');
    } finally { setLoading(false); }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-eyebrow">OpenMedias · Sales Dashboard</div>
        <div className="login-title">Performance<br />Commerciale</div>
        <input
          className="login-input" type="password" placeholder="Mot de passe"
          value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} autoFocus
        />
        <button className="login-btn" onClick={submit} disabled={loading}>
          {loading ? 'Connexion…' : 'Accéder au dashboard'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}

// ---------- petites briques ----------
function Kpi({ label, value, sub, color, dot, glow }) {
  return (
    <div className={`tile kpi ${glow ? 'glow-blue' : ''} col-2`}>
      <div className="kpi-top">
        <span className="tile-dot" style={{ background: dot }} />
        <span className={`kpi-label ${color}`}>{label}</span>
      </div>
      <div className="kpi-num">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function TileHead({ dotClass, title }) {
  return (
    <div className="tile-head">
      <span className={`tile-dot ${dotClass}`} />
      <span className="tile-title">{title}</span>
    </div>
  );
}

function TopList({ rows, isAmount, color }) {
  if (!rows || rows.length === 0) return <div className="empty">Aucune donnée</div>;
  const top = rows.slice(0, 6);
  return (
    <div className="toplist">
      {top.map((r, i) => (
        <div className="toprow" key={i}>
          <div className="toprank">{i + 1}</div>
          <div className="topname">{r.name}</div>
          <div className={`topval ${color}`}>
            {isAmount ? `${fmt(r.amount)} €` : r.count}
          </div>
        </div>
      ))}
    </div>
  );
}

// Tooltip sombre custom pour Recharts
function DarkTooltip({ active, payload, label, suffix }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: '#14142C', border: '1px solid #20203E', borderRadius: 8,
      padding: '8px 12px', fontSize: 12, color: '#fff',
    }}>
      <div style={{ color: '#8B8BB0', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700 }}>
        {fmt(payload[0].value)}{suffix || ''}
      </div>
    </div>
  );
}

// ---------- DASHBOARD ----------
function Dashboard({ password, onLogout }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/dashboard', {
        headers: { 'x-dashboard-password': password },
      });
      if (res.status === 401) { onLogout(); return; }
      if (!res.ok) throw new Error('Erreur serveur');
      setData(await res.json());
    } catch (e) {
      setError(String(e.message || e));
    } finally { setLoading(false); }
  }, [password, onLogout]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div className="shell">
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

  // données graphes
  const caBySales = (rev.detail || []).slice(0, 8).map((r) => ({
    name: r.name.split(' ')[0], full: r.name, value: r.amount,
  }));
  const callsBySales = (calls.detail || []).slice(0, 8).map((r) => ({
    name: r.name.split(' ')[0], full: r.name, value: r.count,
  }));
  const rdvPie = [
    { name: 'R1 pris', value: rdvB.r1.total, fill: '#FBBF24' },
    { name: 'R2 pris', value: rdvB.r2.total, fill: '#60A5FA' },
  ].filter((x) => x.value > 0);

  return (
    <div className="shell">
      {/* TOPBAR */}
      <div className="topbar">
        <div className="topbar-left">
          <div>
            <div className="brand-eyebrow">OpenMedias · Sales Dashboard</div>
            <div className="brand-title">Performance Commerciale</div>
          </div>
          <div className="brand-date">{todayLabel()}</div>
        </div>
        <div className="topbar-right">
          {d.generatedAt && <span className="maj">MAJ {timeLabel(d.generatedAt)}</span>}
          <button className={`refresh-btn ${loading ? 'loading' : ''}`} onClick={load} disabled={loading}>
            <span className="refresh-icon">↻</span>
            {loading ? 'Maj…' : 'Rafraîchir'}
          </button>
        </div>
      </div>

      {/* erreurs partielles */}
      {(error || d.errors) && (
        <div style={{ marginBottom: 12 }}>
          {error && <div className="err-pill"><strong>Erreur :</strong> {error}</div>}
          {d.errors && Object.entries(d.errors).map(([k, v]) => (
            <div className="err-pill" key={k}><strong>{k}</strong> — {v}</div>
          ))}
        </div>
      )}

      {/* GRID */}
      <div className="grid">
        {/* Rangée KPIs : 5 KPIs (col-2 chacun = 10) + hero CA pas ici */}
        <Kpi label="Calls" value={calls.total} sub="passés aujourd'hui" color="c-blue" dot="#5B57FF" />
        <Kpi label="R1 jour" value={rdvT.r1.total} sub="échanges" color="c-green" dot="#22C55E" />
        <Kpi label="R2 jour" value={rdvT.r2.total} sub="retours" color="c-bluer2" dot="#60A5FA" />
        <Kpi label="Propals" value={propals.total} sub="envoyées" color="c-orange" dot="#F97316" />
        <Kpi label="Signatures" value={sig.total} sub="du jour" color="c-violet" dot="#A78BFA" glow />

        {/* Hero CA (col-2 pour compléter la ligne de 12) */}
        <div className="tile hero-ca col-2">
          <div className="lbl">CA mois</div>
          <div className="val">{fmt(rev.totalAmount)}€</div>
          <div className="sub">cumul signé</div>
        </div>

        {/* Rangée 2 : R1/R2 pris (KPIs) + graphe CA */}
        <Kpi label="R1 pris" value={rdvB.r1.total} sub="bookés aujourd'hui" color="c-amber" dot="#FBBF24" />
        <Kpi label="R2 pris" value={rdvB.r2.total} sub="bookés aujourd'hui" color="c-amber" dot="#FBBF24" />

        {/* Graphe CA par sales */}
        <div className="tile col-8">
          <TileHead dotClass="bg-blue" title="CA du mois par commercial" />
          <div className="chart-box" style={{ height: 220 }}>
            {caBySales.length === 0 ? (
              <div className="empty">Aucune donnée</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={caBySales} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                  <XAxis dataKey="name" tick={{ fill: '#8B8BB0', fontSize: 11 }} axisLine={{ stroke: '#20203E' }} tickLine={false} />
                  <YAxis tick={{ fill: '#5A5A80', fontSize: 10 }} axisLine={false} tickLine={false} width={50}
                    tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip content={<DarkTooltip suffix=" €" />} cursor={{ fill: 'rgba(91,87,255,0.08)' }} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {caBySales.map((e, i) => (
                      <Cell key={i} fill={i === 0 ? '#5B57FF' : '#3F3BFB'} fillOpacity={i === 0 ? 1 : 0.55} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Rangée 3 : graphe calls + donut RDV pris + top signatures */}
        <div className="tile col-5">
          <TileHead dotClass="bg-blue" title="Calls par commercial" />
          <div className="chart-box" style={{ height: 200 }}>
            {callsBySales.length === 0 ? (
              <div className="empty">Aucun call aujourd'hui</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={callsBySales} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: '#5A5A80', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#8B8BB0', fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(91,87,255,0.08)' }} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} fill="#5B57FF" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="tile col-3">
          <TileHead dotClass="bg-amber" title="RDV pris — répartition" />
          <div className="chart-box" style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {rdvPie.length === 0 ? (
              <div className="empty">Aucun RDV pris</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={rdvPie} dataKey="value" nameKey="name" cx="50%" cy="50%"
                    innerRadius={45} outerRadius={75} paddingAngle={3} stroke="none">
                    {rdvPie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Pie>
                  <Tooltip content={<DarkTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 4 }}>
            <span style={{ fontSize: 11, color: '#8B8BB0' }}><span style={{ color: '#FBBF24' }}>●</span> R1 {rdvB.r1.total}</span>
            <span style={{ fontSize: 11, color: '#8B8BB0' }}><span style={{ color: '#60A5FA' }}>●</span> R2 {rdvB.r2.total}</span>
          </div>
        </div>

        <div className="tile col-4">
          <TileHead dotClass="bg-violet" title="Signatures du jour" />
          {sig.detail.length === 0 ? (
            <div className="empty">Aucune signature aujourd'hui</div>
          ) : (
            <div>
              {sig.detail.map((s, i) => (
                <div className="sig-row" key={i}>
                  <span className="sig-name">{s.name}</span>
                  <span className="sig-val">{fmt(s.amount)} €</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Rangée 4 : top propals + top R1 pris + top R2 pris + salesforge */}
        <div className="tile col-3">
          <TileHead dotClass="bg-orange" title="Propals par sales" />
          <TopList rows={propals.detail} color="c-orange" />
        </div>
        <div className="tile col-3">
          <TileHead dotClass="bg-amber" title="R1 pris par sales" />
          <TopList rows={rdvB.r1.detail} color="c-amber" />
        </div>
        <div className="tile col-3">
          <TileHead dotClass="bg-amber" title="R2 pris par sales" />
          <TopList rows={rdvB.r2.detail} color="c-amber" />
        </div>
        <div className="tile col-3">
          <TileHead dotClass="bg-bluer2" title="SalesForge — cumul" />
          <TopList rows={sf.detail} color="c-bluer2" />
        </div>
      </div>

      {/* FOOTER */}
      <div className="foot">
        <span className="foot-brand">OPENMEDIAS</span>
        <span className="foot-sub">Live · Aircall + Calendly + Salesforce · {new Date().getFullYear()}</span>
      </div>
    </div>
  );
}

// ---------- ROOT ----------
export default function App() {
  const [password, setPassword] = useState(null);

  useEffect(() => {
    const saved = sessionStorage.getItem('om_pw');
    if (saved) setPassword(saved);
  }, []);

  const handleSuccess = (pw) => { sessionStorage.setItem('om_pw', pw); setPassword(pw); };
  const handleLogout = () => { sessionStorage.removeItem('om_pw'); setPassword(null); };

  if (!password) return <Login onSuccess={handleSuccess} />;
  return <Dashboard password={password} onLogout={handleLogout} />;
}
