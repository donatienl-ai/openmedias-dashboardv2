import React, { useEffect, useState } from 'react';
import './DataGuide.css';

const definitions = [
  ['CA gagné', 'Salesforce', 'Montant des opportunités gagnées, selon leur date de clôture. La facturation et les encaissements sont suivis dans Recouvrement.'],
  ['Ventes gagnées', 'Salesforce', 'Nombre d’opportunités gagnées sur la période. Les signatures électroniques DocuSign sont comptées dans les BDC.'],
  ['Propositions suivies', 'Salesforce', 'Pistes et comptes dont le statut actuel correspond à une proposition et dont la dernière modification se situe sur la période. Cet indicateur ne reconstitue pas un historique des envois.'],
  ['R1 / R2', 'Calendly', 'Rendez-vous programmés sur la période. Le sous-indicateur « pris » suit leur date de réservation. La présence effective au rendez-vous n’est pas attestée.'],
  ['Appels', 'Aircall', 'Appels entrants et sortants sur la période. Une éventuelle limite de collecte est signalée.'],
  ['Volumes d’activité', 'Plusieurs sources', 'Les ratios rapprochent les volumes de la période. Ils ne suivent pas les mêmes prospects à chaque étape et ne mesurent donc pas un taux de conversion par cohorte.'],
];

function ageLabel(timestamp, now) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 'date inconnue';
  const minutes = Math.max(0, Math.floor((now-time)/60000));
  if (minutes < 1) return 'moins d’une minute';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes/60)} h ${minutes%60} min`;
  return new Date(time).toLocaleString('fr-FR');
}

export default function DataGuide({ data }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(id); }, []);
  const incomplete = !!data.errors || data.calls?.truncated;
  const unmatched = new Set();
  for (const key of ['calls','revenue','propals','propalsComptes','salesforge']) {
    for (const row of data[key]?.detail || []) if (row.unmatched) unmatched.add(row.name);
  }
  return (
    <details className="data-guide">
      <summary>
        <span>Sources et définition des chiffres</span>
        <span className={`data-guide-state ${incomplete ? 'is-warning' : ''}`}>
          {incomplete ? 'Données partielles' : `Vue calculée il y a ${ageLabel(data.generatedAt, now)}`}
        </span>
      </summary>
      <div className="data-guide-body">
        <p>Les données sont synchronisées périodiquement. Rafraîchir la vue peut réutiliser les données déjà collectées.</p>
        <ul className="data-source-list">
          {(data.sources || []).map(s => <li key={s.id}><strong>{s.label}</strong><span>Collecte la plus ancienne observée : {ageLabel(s.oldestCacheAt, now)}{s.incomplete ? ' · collecte partielle' : ''}</span></li>)}
        </ul>
        <p className="data-guide-note">Ces dates décrivent les caches observés lors du calcul de la vue ; elles ne garantissent pas la fraîcheur de chaque enregistrement chez le fournisseur.</p>
        {unmatched.size > 0 && <p className="data-guide-warning">{unmatched.size} nom(s) de source restent sans rattachement certain. Leurs valeurs sont conservées dans les totaux non filtrés ; un filtre sur un commercial les exclut.</p>}
        <dl>{definitions.map(([label,source,description]) => <div key={label}><dt>{label} <span>{source}</span></dt><dd>{description}</dd></div>)}</dl>
      </div>
    </details>
  );
}
