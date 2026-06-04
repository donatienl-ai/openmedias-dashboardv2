import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { TEAMS, ALL_SALES, allowedNames } from './teams';

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

// ---------- MODALE détail ----------
function DetailModal({ open, title, rows, isAmount, accent, onClose }) {
  if (!open) return null;
  const max = Math.max(1, ...rows.map((r) => (isAmount ? r.amount : r.count)));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          {rows.length === 0 ? (
            <div className="empty">Aucune donnée</div>
          ) : (
            rows.map((r, i) => {
              const v = isAmount ? r.amount : r.count;
              const pct = Math.round((v / max) * 100);
              return (
                <div className="mrow" key={i}>
                  <div className="mrow-rank">{i + 1}</div>
                  <div className="mrow-main">
                    <div className="mrow-top">
                      <span className="mrow-name">{r.name}</span>
                      <span className={`mrow-val ${v === 0 ? 'zero' : accent}`}>
                        {isAmount ? `${fmt(r.amount)} €` : r.count}
                      </span>
                    </div>
                    <div className="mrow-bar-bg">
                      <div className={`mrow-bar ${accent}-bg`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- KPI cliquable ----------
function Kpi({ label, value, sub, color, dot, glow, onClick, clickable }) {
  return (
    <div
      className={`tile kpi ${glow ? 'glow-blue' : ''} col-2 ${clickable ? 'clickable' : ''}`}
      onClick={onClick}
    >
      <div className="kpi-top">
        <span className="tile-dot" style={{ background: dot }} />
        <span className={`kpi-label ${color}`}>{label}</span>
        {clickable && <span className="kpi-expand">⤢</span>}
      </div>
      <div className="kpi-num">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

function TileHead({ dotClass, title, clickable }) {
  return (
    <div className="tile-head">
      <span className={`tile-dot ${dotClass}`} />
      <span className="tile-title">{title}</span>
      {clickable && <span className="tile-expand">⤢ détail</span>}
    </div>
  );
}

// Top liste compacte (seulement ceux > 0, max 6)
function TopList({ rows, isAmount, color }) {
  const active = (rows || []).filter((r) => (isAmount ? r.amount : r.count) > 0);
  if (active.length === 0) return <div className="empty">Aucune donnée</div>;
  const top = active.slice(0, 6);
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

function DarkTooltip({ active, payload, label, suffix }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{
      background: '#14142C', border: '1px solid #20203E', borderRadius: 8,
      padding: '8px 12px', fontSize: 12, color: '#fff',
    }}>
      <div style={{ color: '#8B8BB0', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700 }}>{fmt(payload[0].value)}{suffix || ''}</div>
    </div>
  );
}

// ---------- SÉLECTEUR DE PÉRIODE ----------
const PRESETS = [
  { id: 'today', label: "Aujourd'hui" },
  { id: 'yesterday', label: 'Hier' },
  { id: 'this_week', label: 'Cette semaine' },
  { id: 'last_week', label: 'Semaine dernière' },
  { id: 'this_month', label: 'Ce mois' },
  { id: 'last_month', label: 'Mois dernier' },
  { id: 'last_7', label: '7 derniers jours' },
  { id: 'last_30', label: '30 derniers jours' },
];

function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function PeriodSelector({ current, label, onApply }) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [cStart, setCStart] = useState(todayISO());
  const [cEnd, setCEnd] = useState(todayISO());

  const choosePreset = (id) => {
    setOpen(false);
    setShowCustom(false);
    onApply({ preset: id });
  };

  const applyCustom = () => {
    if (!cStart || !cEnd) return;
    setOpen(false);
    setShowCustom(false);
    onApply({ preset: 'custom', start: cStart, end: cEnd });
  };

  return (
    <div className="period">
      <button className="period-btn" onClick={() => setOpen((o) => !o)}>
        <span className="period-cal">📅</span>
        <span className="period-label">{label || "Aujourd'hui"}</span>
        <span className="period-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="period-backdrop" onClick={() => { setOpen(false); setShowCustom(false); }} />
          <div className="period-menu">
            {!showCustom ? (
              <>
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`period-item ${current === p.id ? 'active' : ''}`}
                    onClick={() => choosePreset(p.id)}
                  >
                    {p.label}
                    {current === p.id && <span className="period-check">✓</span>}
                  </button>
                ))}
                <div className="period-sep" />
                <button
                  className={`period-item ${current === 'custom' ? 'active' : ''}`}
                  onClick={() => setShowCustom(true)}
                >
                  Personnalisé…
                  <span className="period-arrow">›</span>
                </button>
              </>
            ) : (
              <div className="period-custom">
                <div className="period-custom-title">Choisir une plage</div>
                <label className="period-field">
                  <span>Du</span>
                  <input type="date" value={cStart} max={cEnd} onChange={(e) => setCStart(e.target.value)} />
                </label>
                <label className="period-field">
                  <span>Au</span>
                  <input type="date" value={cEnd} min={cStart} max={todayISO()} onChange={(e) => setCEnd(e.target.value)} />
                </label>
                <div className="period-custom-actions">
                  <button className="period-cancel" onClick={() => setShowCustom(false)}>Retour</button>
                  <button className="period-apply" onClick={applyCustom}>Appliquer</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- FILTRE ÉQUIPE / SALES ----------
function FilterDropdown({ icon, label, items, current, onPick, allLabel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="period">
      <button className={`period-btn ${current ? 'filter-active' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="period-cal">{icon}</span>
        <span className="period-label">{label}</span>
        <span className="period-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="period-backdrop" onClick={() => setOpen(false)} />
          <div className="period-menu filter-menu">
            <button
              className={`period-item ${!current ? 'active' : ''}`}
              onClick={() => { setOpen(false); onPick(null); }}
            >
              {allLabel}
              {!current && <span className="period-check">✓</span>}
            </button>
            <div className="period-sep" />
            {items.map((it) => (
              <button
                key={it.value}
                className={`period-item ${current === it.value ? 'active' : ''}`}
                onClick={() => { setOpen(false); onPick(it.value); }}
              >
                {it.label}
                {current === it.value && <span className="period-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- DASHBOARD ----------
function Dashboard({ password, onLogout }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [period, setPeriod] = useState({ preset: 'today' }); // {preset, start?, end?}
  const [teamFilter, setTeamFilter] = useState(null);   // id d'équipe ou null
  const [saleFilter, setSaleFilter] = useState(null);   // nom de sale ou null

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const qs = new URLSearchParams({ preset: period.preset });
      if (period.preset === 'custom') {
        qs.set('start', period.start);
        qs.set('end', period.end);
      }
      const res = await fetch(`/api/dashboard?${qs.toString()}`, {
        headers: { 'x-dashboard-password': password },
      });
      if (res.status === 401) { onLogout(); return; }
      if (!res.ok) throw new Error('Erreur serveur');
      setData(await res.json());
    } catch (e) {
      setError(String(e.message || e));
    } finally { setLoading(false); }
  }, [password, onLogout, period]);

  useEffect(() => { load(); }, [load]);

  // Fermeture modale sur Echap
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setModal(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const rangeLabel = d.range?.label || "Aujourd'hui";
  const isToday = (d.range?.preset || 'today') === 'today';
  // sous-titre court selon la période (ex: "aujourd'hui", "cette semaine"...)
  const periodSub = isToday ? "aujourd'hui" : rangeLabel.toLowerCase();

  // ===== FILTRAGE ÉQUIPE / SALES =====
  // allowed = Set des noms autorisés, ou null = pas de filtre
  const allowed = allowedNames(teamFilter, saleFilter);
  const filterRows = (rows) => {
    if (!allowed) return rows || [];
    return (rows || []).filter((r) => allowed.has(r.name));
  };
  // Recalcule un bloc {total, detail} après filtre
  const fBlock = (block, sumAmount = false) => {
    const detail = filterRows(block?.detail);
    const total = allowed ? detail.reduce((s, r) => s + (r.count || 0), 0) : (block?.total ?? 0);
    const totalAmount = sumAmount
      ? (allowed ? detail.reduce((s, r) => s + (r.amount || 0), 0) : (block?.totalAmount ?? 0))
      : undefined;
    return { ...block, detail, total, ...(sumAmount ? { totalAmount } : {}) };
  };

  const rdvT = {
    r1: fBlock(d.rdvToday?.r1 || { total: 0, detail: [] }),
    r2: fBlock(d.rdvToday?.r2 || { total: 0, detail: [] }),
  };
  const rdvB = {
    r1: fBlock(d.rdvBooked?.r1 || { total: 0, detail: [] }),
    r2: fBlock(d.rdvBooked?.r2 || { total: 0, detail: [] }),
  };
  const sig = fBlock(d.signatures || { total: 0, totalAmount: 0, detail: [] }, true);
  const rev = fBlock(d.revenue || { totalAmount: 0, detail: [] }, true);
  const propals = fBlock(d.propals || { total: 0, detail: [] });
  const calls = fBlock(d.calls || { total: 0, detail: [] });
  const sf = fBlock(d.salesforge || { total: 0, detail: [] });

  // libellé du filtre actif (pour le titre)
  const filterLabel = saleFilter
    ? saleFilter
    : teamFilter
      ? (TEAMS.find((t) => t.id === teamFilter)?.label || '')
      : null;

  // ouvre une modale
  const openModal = (title, rows, isAmount, accent) =>
    setModal({ title, rows: rows || [], isAmount: !!isAmount, accent: accent || 'c-blue' });

  // graphes : seulement sales > 0
  const caBySales = (rev.detail || []).filter((r) => r.amount > 0).slice(0, 8).map((r) => ({
    name: r.name.split(' ')[0], value: r.amount,
  }));
  // Calls : tous les sales avec au moins 1 call (le bloc s'agrandit en conséquence)
  const callsBySales = (calls.detail || []).filter((r) => r.count > 0).map((r) => ({
    name: r.name.split(' ')[0], value: r.count,
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
          <div className="brand-date">
            {todayLabel()}
            {filterLabel && <span className="filter-badge">{filterLabel}</span>}
          </div>
        </div>
        <div className="topbar-right">
          <FilterDropdown
            icon="👥"
            label={teamFilter ? (TEAMS.find((t) => t.id === teamFilter)?.label || 'Équipe') : 'Équipes'}
            allLabel="Toutes les équipes"
            items={TEAMS.map((t) => ({ value: t.id, label: t.label }))}
            current={teamFilter}
            onPick={(v) => { setTeamFilter(v); setSaleFilter(null); }}
          />
          <FilterDropdown
            icon="👤"
            label={saleFilter || 'Sales'}
            allLabel="Tous les sales"
            items={(teamFilter
              ? (TEAMS.find((t) => t.id === teamFilter)?.members || [])
              : ALL_SALES
            ).map((s) => ({ value: s, label: s }))}
            current={saleFilter}
            onPick={(v) => setSaleFilter(v)}
          />
          <PeriodSelector
            current={d.range?.preset || 'today'}
            label={rangeLabel}
            onApply={(p) => setPeriod(p)}
          />
          {d.generatedAt && <span className="maj">MAJ {timeLabel(d.generatedAt)}</span>}
          <button className={`refresh-btn ${loading ? 'loading' : ''}`} onClick={load} disabled={loading}>
            <span className="refresh-icon">↻</span>
            {loading ? 'Maj…' : 'Rafraîchir'}
          </button>
        </div>
      </div>

      {(error || d.errors) && (
        <div style={{ marginBottom: 12 }}>
          {error && <div className="err-pill"><strong>Erreur :</strong> {error}</div>}
          {d.errors && Object.entries(d.errors).map(([k, v]) => (
            <div className="err-pill" key={k}><strong>{k}</strong> — {v}</div>
          ))}
        </div>
      )}

      <div className="grid">
        {/* Rangée KPIs (cliquables sauf CA) */}
        <Kpi label="Calls" value={calls.truncated ? `${fmt(calls.total)}+` : calls.total} sub={calls.truncated ? `plafonné · ${periodSub}` : `passés · ${periodSub}`} color="c-blue" dot="#5B57FF"
          clickable onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue')} />
        <Kpi label="R1" value={rdvT.r1.total} sub={`échanges · ${periodSub}`} color="c-green" dot="#22C55E"
          clickable onClick={() => openModal('R1 par commercial', rdvT.r1.detail, false, 'c-green')} />
        <Kpi label="R2" value={rdvT.r2.total} sub={`retours · ${periodSub}`} color="c-bluer2" dot="#60A5FA"
          clickable onClick={() => openModal('R2 par commercial', rdvT.r2.detail, false, 'c-bluer2')} />
        <Kpi label="Propals" value={propals.total} sub={`envoyées · ${periodSub}`} color="c-orange" dot="#F97316"
          clickable onClick={() => openModal('Propals par commercial', propals.detail, false, 'c-orange')} />
        <Kpi label="Signatures" value={sig.total} sub={periodSub} color="c-violet" dot="#A78BFA" glow />
        <div className="tile hero-ca col-2">
          <div className="lbl">CA · {isToday ? 'du jour' : 'période'}</div>
          <div className="val">{fmt(rev.totalAmount)}€</div>
          <div className="sub">{isToday ? 'cumul signé' : rangeLabel.toLowerCase()}</div>
        </div>

        {/* Rangée 2 : R1/R2 pris (cliquables) + graphe CA */}
        <Kpi label="R1 pris" value={rdvB.r1.total} sub={`bookés · ${periodSub}`} color="c-amber" dot="#FBBF24"
          clickable onClick={() => openModal('R1 pris par commercial', rdvB.r1.detail, false, 'c-amber')} />
        <Kpi label="R2 pris" value={rdvB.r2.total} sub={`bookés · ${periodSub}`} color="c-amber" dot="#FBBF24"
          clickable onClick={() => openModal('R2 pris par commercial', rdvB.r2.detail, false, 'c-amber')} />

        <div className="tile col-8 clickable" onClick={() => openModal(`CA · ${rangeLabel} par commercial`, rev.detail, true, 'c-blue')}>
          <TileHead dotClass="bg-blue" title={`CA ${isToday ? 'du jour' : '· ' + rangeLabel} par commercial`} clickable />
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
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={90}>
                    {caBySales.map((e, i) => (
                      <Cell key={i} fill={i === 0 ? '#5B57FF' : '#3F3BFB'} fillOpacity={i === 0 ? 1 : 0.55} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Rangée 3 */}
        <div className="tile col-5 clickable" onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue')}>
          <TileHead dotClass="bg-blue" title="Calls par commercial" clickable />
          <div className="chart-box" style={{ height: Math.max(200, callsBySales.length * 30) }}>
            {callsBySales.length === 0 ? (
              <div className="empty">Aucun call sur la période</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={callsBySales} layout="vertical" margin={{ top: 0, right: 36, left: 8, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: '#5A5A80', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#8B8BB0', fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(91,87,255,0.08)' }} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} fill="#5B57FF"
                    label={{ position: 'right', fill: '#8B8BB0', fontSize: 11, fontWeight: 700 }} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="tile col-3">
          <TileHead dotClass="bg-amber" title="RDV pris — répartition" />
          <div className="chart-box" style={{ height: 200 }}>
            {rdvPie.length === 0 ? (
              <div className="empty">Aucun RDV pris</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rdvPie} margin={{ top: 24, right: 8, left: 8, bottom: 4 }} barCategoryGap="30%">
                  <XAxis dataKey="name" tick={{ fill: '#C5C5D8', fontSize: 13, fontWeight: 700 }} axisLine={{ stroke: '#20203E' }} tickLine={false} />
                  <YAxis tick={{ fill: '#5A5A80', fontSize: 10 }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]} maxBarSize={70}
                    label={{ position: 'top', fill: '#FFFFFF', fontSize: 16, fontWeight: 800 }}>
                    {rdvPie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="rdv-legend">
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#FBBF24' }} />R1 pris<b>{rdvB.r1.total}</b></span>
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#60A5FA' }} />R2 pris<b>{rdvB.r2.total}</b></span>
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

        {/* Rangée 4 : tops cliquables */}
        <div className="tile col-3 clickable" onClick={() => openModal('Propals par commercial', propals.detail, false, 'c-orange')}>
          <TileHead dotClass="bg-orange" title="Propals par sales" clickable />
          <TopList rows={propals.detail} color="c-orange" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('R1 pris par commercial', rdvB.r1.detail, false, 'c-amber')}>
          <TileHead dotClass="bg-amber" title="R1 pris par sales" clickable />
          <TopList rows={rdvB.r1.detail} color="c-amber" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('R2 pris par commercial', rdvB.r2.detail, false, 'c-amber')}>
          <TileHead dotClass="bg-amber" title="R2 pris par sales" clickable />
          <TopList rows={rdvB.r2.detail} color="c-amber" />
        </div>
        <div className="tile col-3 clickable" onClick={() => openModal('RDV SalesForge par commercial', sf.detail, false, 'c-bluer2')}>
          <TileHead dotClass="bg-bluer2" title={`SalesForge · ${sf.total} RDV`} clickable />
          <TopList rows={sf.detail} color="c-bluer2" />
        </div>
      </div>

      <div className="foot">
        <span className="foot-brand">OPENMEDIAS</span>
        <span className="foot-sub">Live · Aircall + Calendly + Salesforce · {new Date().getFullYear()}</span>
      </div>

      <DetailModal
        open={!!modal}
        title={modal?.title}
        rows={modal?.rows || []}
        isAmount={modal?.isAmount}
        accent={modal?.accent}
        onClose={() => setModal(null)}
      />
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
