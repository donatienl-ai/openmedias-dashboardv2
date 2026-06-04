import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import { TEAMS, ALL_SALES, allowedNames, DEFAULT_HIDDEN, ACCOUNTS } from './teams';

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

// ---------- KPI cliquable (avec métrique secondaire optionnelle) ----------
function Kpi({ label, value, sub, color, dot, glow, onClick, clickable, secondary }) {
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
      {secondary && (
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
function TopList({ rows, isAmount, color, max = 6 }) {
  const active = (rows || []).filter((r) => (isAmount ? r.amount : r.count) > 0);
  if (active.length === 0) return <div className="empty">Aucune donnée</div>;
  const top = active.slice(0, max);
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
      background: '#101B30', border: '1px solid #1B2A45', borderRadius: 8,
      padding: '8px 12px', fontSize: 12, color: '#fff',
    }}>
      <div style={{ color: '#8B8BB0', marginBottom: 2 }}>{label}</div>
      {payload.length === 1 ? (
        <div style={{ fontWeight: 700 }}>{fmt(payload[0].value)}{suffix || ''}</div>
      ) : (
        payload.map((p, i) => (
          <div key={i} style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color || p.fill, display: 'inline-block' }} />
            <span style={{ color: '#8295B5', fontWeight: 500 }}>{p.name}</span>
            {fmt(p.value)}{suffix || ''}
          </div>
        ))
      )}
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

// ---------- PARAMÈTRES ADMIN (sales visibles) ----------
function SettingsModal({ open, hidden, onToggle, onShowAll, onClose }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">⚙️ Paramètres · Sales visibles</span>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-body">
          <div className="set-hint">
            Désactive un commercial pour le masquer de tout le dashboard
            (listes, graphes et totaux recalculés). Réglage mémorisé sur ce navigateur.
          </div>
          {hidden.size > 0 && (
            <button className="set-showall" onClick={onShowAll}>
              Tout réafficher ({hidden.size} masqué{hidden.size > 1 ? 's' : ''})
            </button>
          )}
          {ALL_SALES.map((s) => (
            <label className="set-row" key={s}>
              <span className={`set-name ${hidden.has(s) ? 'off' : ''}`}>{s}</span>
              <input
                type="checkbox"
                className="set-check"
                checked={!hidden.has(s)}
                onChange={() => onToggle(s)}
              />
              <span className="set-switch" />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- DASHBOARD ----------
function Dashboard({ password, onLogout, theme, onToggleTheme }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [period, setPeriod] = useState({ preset: 'today' }); // {preset, start?, end?}
  const [teamFilter, setTeamFilter] = useState(null);   // id d'équipe ou null
  const [saleFilter, setSaleFilter] = useState(null);   // nom de sale ou null
  const [showSettings, setShowSettings] = useState(false);
  const [bdcView, setBdcView] = useState('pending'); // 'sent' | 'signed' | 'pending'
  const [hiddenSales, setHiddenSales] = useState(() => {
    // Si l'utilisateur n'a jamais touché aux paramètres sur ce navigateur,
    // on applique le masquage par défaut (hors-équipe sauf Thomas Durand).
    try {
      const saved = localStorage.getItem('om_hidden_sales');
      return saved !== null ? JSON.parse(saved) : DEFAULT_HIDDEN;
    } catch { return DEFAULT_HIDDEN; }
  });

  // Persiste la liste des sales masqués
  useEffect(() => {
    localStorage.setItem('om_hidden_sales', JSON.stringify(hiddenSales));
  }, [hiddenSales]);

  const toggleHidden = (name) =>
    setHiddenSales((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

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
    const onKey = (e) => { if (e.key === 'Escape') { setModal(null); setShowSettings(false); } };
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

  // Couleurs de graphes adaptées au thème (les charts Recharts ne lisent pas les CSS vars)
  const isLight = theme === 'light';
  const ct = {
    axis: isLight ? '#DEE6F0' : '#1B2A45',
    tick: isLight ? '#72839F' : '#8295B5',
    tickFaint: isLight ? '#93A3BD' : '#54678A',
    tickBold: isLight ? '#33455F' : '#C3D0E3',
    labelStrong: isLight ? '#101A2E' : '#FFFFFF',
  };

  // ===== FILTRAGE ÉQUIPE / SALES + masqués (paramètres) =====
  // allowed = Set des noms autorisés, ou null = pas de filtre
  const allowed = allowedNames(teamFilter, saleFilter);
  const hidden = new Set(hiddenSales);
  const keepRow = (r) => (!allowed || allowed.has(r.name)) && !hidden.has(r.name);
  const filterRows = (rows) => (rows || []).filter(keepRow);
  const mustRecalc = !!allowed || hidden.size > 0;
  // Recalcule un bloc {total, detail} après filtre
  const fBlock = (block, sumAmount = false) => {
    const detail = filterRows(block?.detail);
    const total = mustRecalc ? detail.reduce((s, r) => s + (r.count || 0), 0) : (block?.total ?? 0);
    const totalAmount = sumAmount
      ? (mustRecalc ? detail.reduce((s, r) => s + (r.amount || 0), 0) : (block?.totalAmount ?? 0))
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
  const bdc = {
    sent: fBlock(d.bdc?.sent || { total: 0, detail: [] }),
    signed: fBlock(d.bdc?.signed || { total: 0, detail: [] }),
    pending: fBlock(d.bdc?.pending || { total: 0, detail: [] }),
  };
  // Split propals : sales vs accounts (Lisa, Quentin, David, Paul, Thomas)
  const isAccount = (name) => ACCOUNTS.includes(name);
  const propalsSales = {
    detail: propals.detail.filter((r) => !isAccount(r.name)),
    total: propals.detail.filter((r) => !isAccount(r.name)).reduce((s, r) => s + (r.count || 0), 0),
  };
  const propalsAccounts = {
    detail: propals.detail.filter((r) => isAccount(r.name)),
    total: propals.detail.filter((r) => isAccount(r.name)).reduce((s, r) => s + (r.count || 0), 0),
  };

  // Totaux calls entrants/sortants (recalculés si filtre ou masquage actif)
  const callsIn = mustRecalc
    ? calls.detail.reduce((s, r) => s + (r.inbound || 0), 0)
    : (calls.totalInbound ?? 0);
  const callsOut = mustRecalc
    ? calls.detail.reduce((s, r) => s + (r.outbound || 0), 0)
    : (calls.totalOutbound ?? 0);

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
    name: r.name.split(' ')[0],
    total: r.count,
    outbound: r.outbound || 0,
    inbound: r.inbound || 0,
  }));
  const rdvPie = [
    { name: 'R1 pris', value: rdvB.r1.total, fill: '#FBBF24' },
    { name: 'R2 pris', value: rdvB.r2.total, fill: '#22D3EE' },
  ].filter((x) => x.value > 0);

  return (
    <div className="shell">
      {/* TOPBAR */}
      <div className="topbar">
        <div className="topbar-left">
          <div className="brand-eyebrow">OpenMedias · Sales Dashboard</div>
          <div className="brand-title">Performance Commerciale</div>
          <div className="context-line">
            <span>{todayLabel()}</span>
            {!isToday && <span className="period-chip">{rangeLabel}</span>}
            {filterLabel && <span className="filter-badge">{filterLabel}</span>}
            {hidden.size > 0 && <span className="hidden-chip">{hidden.size} masqué{hidden.size > 1 ? 's' : ''}</span>}
          </div>
        </div>
        <div className="topbar-right">
          <div className="controls-group">
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
              ).filter((s) => !hidden.has(s)).map((s) => ({ value: s, label: s }))}
              current={saleFilter}
              onPick={(v) => setSaleFilter(v)}
            />
            <PeriodSelector
              current={d.range?.preset || 'today'}
              label={rangeLabel}
              onApply={(p) => setPeriod(p)}
            />
          </div>
          <div className="topbar-divider" />
          <div className="status-cluster">
            <button className="theme-btn" onClick={() => setShowSettings(true)} title="Paramètres">
              ⚙️
            </button>
            <button className="theme-btn" onClick={onToggleTheme} title={theme === 'dark' ? 'Mode clair' : 'Mode sombre'}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            {d.generatedAt && <span className="maj">MAJ {timeLabel(d.generatedAt)}</span>}
            <button className={`refresh-btn ${loading ? 'loading' : ''}`} onClick={load} disabled={loading}>
              <span className="refresh-icon">↻</span>
              {loading ? 'Maj…' : 'Rafraîchir'}
            </button>
          </div>
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
        {/* ===== BANDE KPI — duo cards (R1/R2 intègrent leurs "pris") ===== */}
        <Kpi label="Calls" value={calls.truncated ? `${fmt(calls.total)}+` : calls.total}
          sub={calls.truncated ? 'plafonné' : 'passés'} color="c-blue" dot="#3B82F6"
          secondary={[
            { value: callsOut, label: 'out', dot: '#2563EB' },
            { value: callsIn, label: 'in', dot: '#60A5FA' },
          ]}
          clickable onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue')} />
        <Kpi label="R1" value={rdvT.r1.total} sub="échanges" color="c-green" dot="#22C55E"
          secondary={{ value: rdvB.r1.total, label: 'pris', dot: '#FBBF24' }}
          clickable onClick={() => openModal('R1 par commercial', rdvT.r1.detail, false, 'c-green')} />
        <Kpi label="R2" value={rdvT.r2.total} sub="retours" color="c-bluer2" dot="#22D3EE"
          secondary={{ value: rdvB.r2.total, label: 'pris', dot: '#FBBF24' }}
          clickable onClick={() => openModal('R2 par commercial', rdvT.r2.detail, false, 'c-bluer2')} />
        <Kpi label="Propals" value={propals.total} sub="envoyées" color="c-orange" dot="#F97316"
          secondary={[
            { value: propalsSales.total, label: 'sales', dot: '#F97316' },
            { value: propalsAccounts.total, label: 'comptes', dot: '#FBBF24' },
          ]}
          clickable onClick={() => openModal('Propals par commercial', propals.detail, false, 'c-orange')} />
        <Kpi label="Signatures" value={sig.total} sub="deals signés" color="c-violet" dot="#3B82F6" glow />
        <div className="tile hero-ca col-2">
          <div className="lbl">CA · {isToday ? 'du jour' : 'période'}</div>
          <div className="val">{fmt(rev.totalAmount)}€</div>
          <div className="sub">{isToday ? 'cumul signé' : rangeLabel.toLowerCase()}</div>
        </div>

        {/* ===== RANGÉE MONEY — CA + Signatures ===== */}
        <div className="tile col-8 clickable" onClick={() => openModal(`CA · ${rangeLabel} par commercial`, rev.detail, true, 'c-blue')}>
          <TileHead dotClass="bg-blue" title={`CA ${isToday ? 'du jour' : '· ' + rangeLabel} par commercial`} clickable />
          <div className="chart-box" style={{ height: 250 }}>
            {caBySales.length === 0 ? (
              <div className="empty">Aucune donnée</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={caBySales} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                  <XAxis dataKey="name" tick={{ fill: ct.tick, fontSize: 11 }} axisLine={{ stroke: ct.axis }} tickLine={false} />
                  <YAxis tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} width={50}
                    tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                  <Tooltip content={<DarkTooltip suffix=" €" />} cursor={{ fill: 'rgba(59,130,246,0.10)' }} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={90}>
                    {caBySales.map((e, i) => (
                      <Cell key={i} fill={i === 0 ? '#3B82F6' : '#2563EB'} fillOpacity={i === 0 ? 1 : 0.55} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="tile col-4">
          <TileHead dotClass="bg-violet" title={isToday ? 'Signatures du jour' : `Signatures · ${rangeLabel}`} />
          {sig.detail.length === 0 ? (
            <div className="empty">Aucune signature</div>
          ) : (
            <div className="sig-scroll">
              {sig.detail.map((s, i) => (
                <div className="sig-row" key={i}>
                  <span className="sig-name">{s.name}</span>
                  <span className="sig-val">{fmt(s.amount)} €</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ===== RANGÉE ACTIVITÉ — Calls top 10 + RDV pris + SalesForge ===== */}
        <div className="tile col-5 clickable" onClick={() => openModal('Calls par commercial', calls.detail, false, 'c-blue')}>
          <TileHead dotClass="bg-blue" title={`Calls par commercial${callsBySales.length > 10 ? ' · top 10' : ''}`} clickable />
          <div className="chart-box" style={{ height: Math.max(200, Math.min(callsBySales.length, 10) * 30) }}>
            {callsBySales.length === 0 ? (
              <div className="empty">Aucun call sur la période</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={callsBySales.slice(0, 10)} layout="vertical" margin={{ top: 0, right: 36, left: 8, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: ct.tick, fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(59,130,246,0.10)' }} />
                  <Bar dataKey="outbound" name="Sortants" stackId="dir" fill="#2563EB" />
                  <Bar dataKey="inbound" name="Entrants" stackId="dir" fill="#60A5FA" radius={[0, 6, 6, 0]}>
                    <LabelList dataKey="total" position="right" fill={ct.tick} fontSize={11} fontWeight={700} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="rdv-legend">
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#2563EB' }} />Sortants<b>{callsOut}</b></span>
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#60A5FA' }} />Entrants<b>{callsIn}</b></span>
          </div>
          {callsBySales.length > 10 && <div className="see-all">⤢ Voir les {callsBySales.length} commerciaux</div>}
        </div>

        <div className="tile col-3">
          <TileHead dotClass="bg-amber" title="RDV pris — répartition" />
          <div className="chart-box" style={{ height: 200 }}>
            {rdvPie.length === 0 ? (
              <div className="empty">Aucun RDV pris</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rdvPie} margin={{ top: 24, right: 8, left: 8, bottom: 4 }} barCategoryGap="30%">
                  <XAxis dataKey="name" tick={{ fill: ct.tickBold, fontSize: 13, fontWeight: 700 }} axisLine={{ stroke: ct.axis }} tickLine={false} />
                  <YAxis tick={{ fill: ct.tickFaint, fontSize: 10 }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="value" radius={[8, 8, 0, 0]} maxBarSize={70}
                    label={{ position: 'top', fill: ct.labelStrong, fontSize: 16, fontWeight: 800 }}>
                    {rdvPie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="rdv-legend">
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#FBBF24' }} />R1 pris<b>{rdvB.r1.total}</b></span>
            <span className="rdv-leg-item"><span className="rdv-leg-dot" style={{ background: '#22D3EE' }} />R2 pris<b>{rdvB.r2.total}</b></span>
          </div>
        </div>

        <div className="tile col-4">
          <TileHead dotClass="bg-violet" title="BDC · DocuSign" />
          <div className="bdc-stats">
            {[
              { key: 'sent', label: 'Envoyés', color: 'c-orange', title: 'BDC envoyés par commercial' },
              { key: 'signed', label: 'Signés', color: 'c-green', title: 'BDC signés par commercial' },
              { key: 'pending', label: 'En attente', color: 'c-amber', title: 'BDC en attente de signature' },
            ].map((v) => (
              <button
                key={v.key}
                className={`bdc-stat ${bdcView === v.key ? 'active' : ''}`}
                onClick={() => setBdcView(v.key)}
              >
                <span className={`bdc-stat-val ${v.color}`}>{bdc[v.key].total}</span>
                <span className="bdc-stat-label">{v.label}</span>
              </button>
            ))}
          </div>
          {(() => {
            const meta = {
              sent: { color: 'c-orange', title: 'BDC envoyés par commercial' },
              signed: { color: 'c-green', title: 'BDC signés par commercial' },
              pending: { color: 'c-amber', title: 'BDC en attente de signature' },
            }[bdcView];
            return (
              <>
                <TopList rows={bdc[bdcView].detail} color={meta.color} />
                <div
                  className="see-all linky"
                  onClick={() => openModal(meta.title, bdc[bdcView].detail, false, meta.color)}
                >
                  ⤢ Voir tout
                </div>
              </>
            );
          })()}
        </div>

        {/* ===== RANGÉE CLASSEMENTS ===== */}
        <div className="tile col-3">
          <TileHead dotClass="bg-orange" title="Propals" />
          <div
            className="subsec clickable-zone"
            onClick={() => openModal('Propals · Sales', propalsSales.detail, false, 'c-orange')}
          >
            <div className="subsec-head">
              <span>Sales</span>
              <b className="c-orange">{propalsSales.total}</b>
            </div>
            <TopList rows={propalsSales.detail} color="c-orange" max={4} />
          </div>
          <div
            className="subsec clickable-zone"
            onClick={() => openModal('Propals · Comptes', propalsAccounts.detail, false, 'c-amber')}
          >
            <div className="subsec-head">
              <span>Comptes</span>
              <b className="c-amber">{propalsAccounts.total}</b>
            </div>
            <TopList rows={propalsAccounts.detail} color="c-amber" max={5} />
          </div>
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

      <SettingsModal
        open={showSettings}
        hidden={hidden}
        onToggle={toggleHidden}
        onShowAll={() => setHiddenSales([])}
        onClose={() => setShowSettings(false)}
      />

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
  const [theme, setTheme] = useState(() => localStorage.getItem('om_theme') || 'dark');

  useEffect(() => {
    const saved = sessionStorage.getItem('om_pw');
    if (saved) setPassword(saved);
  }, []);

  // Applique le thème sur <html> et mémorise la préférence
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('om_theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  const handleSuccess = (pw) => { sessionStorage.setItem('om_pw', pw); setPassword(pw); };
  const handleLogout = () => { sessionStorage.removeItem('om_pw'); setPassword(null); };

  if (!password) return <Login onSuccess={handleSuccess} />;
  return <Dashboard password={password} onLogout={handleLogout} theme={theme} onToggleTheme={toggleTheme} />;
}
