// ══════════════════════════════════════════════════════════════════════════════
// KHIDMETI — Watcher démo pour la commission (v4)
//
// RÔLE : joue le "client démo" en continu pendant la période d'essai.
// Deux boucles complémentaires (poll toutes les POLL_SEC secondes) :
//
//   FAST (chaque cycle, ~4 appels API) — pilotée par l'ACTIVITÉ, pas par le
//   volume : seules les requêtes qui ont reçu des offres changent d'état,
//   et elles remontent dans les listes triées par createdAt DESC :
//     1. ACCEPT — GET /service-requests?status=awaitingSelection&limit=100
//        (une offre soumise fait passer open → awaitingSelection côté API) :
//        pour chaque requête démo, la règle d'acceptation s'applique via la
//        VRAIE API (POST /bids/:id/accept, jamais d'écriture Mongo directe) :
//        la quota du worker est débitée, les notifications partent, le
//        contact se déverrouille — la commission teste le flux réel.
//     2. RESET — GET /service-requests?status=bidSelected&limit=100 : une
//        requête acceptée depuis plus de RESET_MIN est rouverte
//        (POST /service-requests/:id/reopen) : chaque membre rejoue la même
//        histoire depuis zéro, sans bouton reset. La fraîcheur est vérifiée
//        AVANT (reopen refuse les dates passées).
//
//   SLOW (1 wilaya = 150 requêtes par cycle, rotation sur les 58) —
//   fraîcheur : si scheduledDate passe sous 24h, repoussée via PATCH à
//   l'offset d'origine J+2…J+8 (même formule que le seed dayOffsetFor) :
//   le démo ne périme jamais. Rotation complète ≈ 58 cycles (≈ 29 min à
//   POLL_SEC=30 — largement sous le seuil 24h).
//
// COUVERTURE v4 : 8700 requêtes = 58 wilayas × 15 professions × 10
// (seed-demo-<profession>-<01…10>-w<code>).
//
// RÈGLE D'ACCEPTATION v4 (par suffixe — MIROIR du seed) :
//   01 'accept'  (la 1re offre est acceptée — flux nominal)
//   02 'never'   (reste en attente — la commission voit "en attente")
//   03–10 mixtes en alternance : 03 accept · 04 never · 05 delayed ·
//     06 accept · 07 never · 08 delayed · 09 accept · 10 never.
//   → chaque worker teste les 3 cas (accept/never/delayed) dans son métier.
//
// USAGE :
//   DEMO_CLIENT_UID=<uid> FIREBASE_WEB_API_KEY=<clé>
//     make scripts-demo-watcher
//   (one-shot, pour tester : ajouter ARGS=--once — fast loop uniquement)
//
// PRÉREQUIS ENV :
//   DEMO_CLIENT_UID      UID Firebase du compte client démo (propriétaire
//                        des 8700 requêtes — le watcher signe en son nom via
//                        un custom token, aucun mot de passe requis).
//   FIREBASE_WEB_API_KEY clé API Web du projet Firebase (khid-web :
//                        VITE_FIREBASE_API_KEY — publique par design, sert
//                        uniquement à échanger le custom token contre un
//                        ID token). Sans elle, pas d'appel API authentifié.
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
//                        service account (même régime que promote-admin.ts)
//                        pour minter le custom token.
//   API_BASE             défaut http://localhost:3000 (prod : l'URL de l'API).
//   POLL_SEC             défaut 30.  RESET_MIN défaut 30.
//   ACCEPT_DELAY_MIN     défaut 15 (suffixes 05 et 08 uniquement).
//
// SÉCURITÉ / FIN DE VIE : processus jetable, hors du runtime (dossier
// scripts/, jamais importé par l'app). À tuer à la fin des essais :
// Ctrl+C — les requêtes seed-demo-* restent, inoffensives (status open,
// owned par le client démo). --clear du seed les efface si besoin.
//
// COMPTES SUPPRIMÉS : si un membre supprime son compte worker puis le
// recrée (même numéro = généralement même UID Firebase, rien ne casse ; si
// vraiment nouvel UID, ses anciennes offres deviennent orphelines) —
// ARGS=--clear-bids du seed les purge.
// ══════════════════════════════════════════════════════════════════════════════

import * as admin from 'firebase-admin';

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = process.env['API_BASE'] ?? 'http://localhost:3000';
const CLIENT_UID = process.env['DEMO_CLIENT_UID'];
const WEB_API_KEY = process.env['FIREBASE_WEB_API_KEY'];
const RESET_MS = (parseInt(process.env['RESET_MIN'] ?? '30', 10) || 30) * 60_000;
const ACCEPT_DELAY_MS =
  (parseInt(process.env['ACCEPT_DELAY_MIN'] ?? '15', 10) || 15) * 60_000;

if (!CLIENT_UID) {
  console.error('❌ DEMO_CLIENT_UID manquant (UID Firebase du client démo).');
  process.exit(1);
}
if (!WEB_API_KEY) {
  console.error(
    '❌ FIREBASE_WEB_API_KEY manquant (clé Web Firebase — cf. khid-web VITE_FIREBASE_API_KEY).',
  );
  process.exit(1);
}

// ── Couverture v4 : 58 wilayas (rotation slow) ───────────────────────────────
const WILAYA_CODES = Array.from({ length: 58 }, (_, i) => i + 1);
const isDemoId = (id: string): boolean => id.startsWith('seed-demo-');

// Règle d'acceptation v4 : 01 accept · 02 never · 03–10 mixtes en alternance.
function ruleFor(reqId: string): 'accept' | 'never' | 'delayed' {
  const m = reqId.match(/-(\d{2})-w\d+$/);
  const n = m ? parseInt(m[1] as string, 10) : 0;
  if (n === 1) return 'accept';
  if (n === 2) return 'never';
  const rest: Array<'accept' | 'never' | 'delayed'> = [
    'accept', 'never', 'delayed', 'accept', 'never', 'delayed', 'accept', 'never',
  ];
  return rest[(n - 3) % rest.length] as 'accept' | 'never' | 'delayed';
}

// Offset d'origine J+2…J+8 — MÊME formule que dayOffsetFor() du seed.
function offsetFor(reqId: string): number {
  const m = reqId.match(/-(\d{2})-w\d+$/);
  const k = (m ? parseInt(m[1] as string, 10) : 1) - 1; // 0…9
  return 2 + (k % 7);
}

// ── Firebase Admin (même pattern que promote-admin.ts) ────────────────────────
function initFirebase(): void {
  if (admin.apps.length > 0) return;
  const projectId = process.env['FIREBASE_PROJECT_ID'];
  const clientEmail = process.env['FIREBASE_CLIENT_EMAIL'];
  const rawKey = process.env['FIREBASE_PRIVATE_KEY'] ?? '';
  // Accepts every storage form: literal "\n" escapes (dotenv files), real
  // newlines (Secrets pasted multiline), wrapping quotes, stray whitespace.
  // Order matters: trim → unquote → unescape → trim again.
  const privateKey = rawKey
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\n/g, '\n')
    .trim();
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Service account Firebase incomplet (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).',
    );
  }
  admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
}

// ── ID token (custom token → échange REST, cache 50 min) ─────────────────────
let cachedToken: { token: string; exp: number } | null = null;
async function idToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp) return cachedToken.token;
  const custom = await admin.auth().createCustomToken(CLIENT_UID as string);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(`Échange custom token → ID token : HTTP ${res.status}`);
  const data = (await res.json()) as { idToken?: string; expiresIn?: string };
  if (!data.idToken) throw new Error('Pas de idToken dans la réponse Firebase');
  cachedToken = {
    token: data.idToken,
    exp: Date.now() + (parseInt(data.expiresIn ?? '3600', 10) - 600) * 1000,
  };
  return cachedToken.token;
}

// ── Appels API ────────────────────────────────────────────────────────────────
interface ApiError extends Error { status?: number; body?: string }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await idToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`) as ApiError;
    err.status = res.status;
    err.body = text;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  // Les endpoints void (ex : POST …/reopen) renvoient 201 corps vide :
  // un json() direct lèverait un SyntaxError.
  const text = await res.text();
  if (!text) return undefined as T;
  const parsed = JSON.parse(text) as unknown;
  // L'API enveloppe les réponses via ResponseInterceptor :
  // { success, data, timestamp }. Déballe `data` quand présent pour
  // retrouver la forme brute (tableau ou document) que le watcher attend.
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'data' in parsed &&
    'success' in parsed
  ) {
    return (parsed as { data: T }).data;
  }
  return parsed as T;
}

interface DemoRequest {
  _id: string; status: string; scheduledDate: string;
  bidSelectedAt: string | null; bidCount: number;
}
interface Bid { _id: string; status: string; workerId: string; createdAt: string }

// STATELESS cron variant: no in-memory firstSeen — the 'delayed' rule
// uses the bid's own createdAt (server-stamped) instead of first-sighting
// time. Each run is independent; nothing is carried between runs.

// ── Fraîcheur (partagée fast + slow) ─────────────────────────────────────────
// Ordre voulu : AVANT tout reset — reopen() refuse les dates passées,
// donc on rafraîchit d'abord pour que le reset ne soit jamais bloqué.
async function refreshIfStale(req: DemoRequest): Promise<boolean> {
  const msLeft = new Date(req.scheduledDate).getTime() - Date.now();
  if (msLeft >= 24 * 36e5) return false;
  const fresh = new Date(Date.now() + offsetFor(req._id) * 864e5);
  fresh.setHours(0, 0, 0, 0);
  await api(`/service-requests/${req._id}`, 'PATCH', { scheduledDate: fresh.toISOString() });
  return true;
}

// ── Accept sur une requête (règle par suffixe) ───────────────────────────────
async function maybeAccept(req: DemoRequest): Promise<boolean> {
  const rule = ruleFor(req._id);
  if (rule === 'never') return false;
  const bids = await api<Bid[]>(`/bids?serviceRequestId=${req._id}&status=pending&limit=20`);
  const pending = bids.filter((b) => b.status === 'pending');
  if (pending.length === 0) return false;

  // Ancienneté : la plus vieille offre pending d'abord (premier arrivé).
  pending.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const first = pending[0];
  if (!first) return false;

  // Stateless 'delayed': the bid's own server-stamped createdAt replaces
  // the in-memory first-sighting clock (which cannot survive a cron run).
  const eligible =
    rule === 'accept' ||
    (rule === 'delayed' && Date.now() - +new Date(first.createdAt) > ACCEPT_DELAY_MS);
  if (!eligible) return false;

  try {
    await api(`/bids/${first._id}/accept`, 'POST');
    return true;
  } catch (err) {
    // Quota du worker épuisé / pas d'abonnement : on log, on ne crash pas.
    console.warn(`⚠️  ${req._id} accept impossible : ${(err as Error).message}`);
    return false;
  }
}

// ── Reset d'une requête acceptée depuis plus de RESET_MIN ────────────────────
async function maybeReopen(req: DemoRequest): Promise<boolean> {
  if (req.status !== 'bidSelected' || !req.bidSelectedAt) return false;
  const age = Date.now() - new Date(req.bidSelectedAt).getTime();
  if (age <= RESET_MS) return false;
  await api(`/service-requests/${req._id}/reopen`, 'POST');
  return true;
}

// ── FAST : pilotée par l'activité (listes triées par createdAt DESC) ─────────
async function fastTick(): Promise<{ accepted: number; reopened: number; refreshed: number }> {
  let accepted = 0, reopened = 0, refreshed = 0;

  // Une offre soumise fait passer open → awaitingSelection : les requêtes
  // avec offres à traiter remontent ici, les plus récentes d'abord.
  const awaiting = await api<DemoRequest[]>('/service-requests?status=awaitingSelection&limit=100');
  for (const req of awaiting) {
    if (!isDemoId(req._id)) continue;
    try {
      if (await maybeAccept(req)) accepted++;
    } catch (err) {
      console.warn(`⚠️  ${req._id} accept : ${(err as Error).message}`);
    }
  }

  // Requêtes acceptées (les plus récentes d'abord) : reset après RESET_MIN.
  const selected = await api<DemoRequest[]>('/service-requests?status=bidSelected&limit=100');
  for (const req of selected) {
    if (!isDemoId(req._id)) continue;
    try {
      if (await refreshIfStale(req)) refreshed++;
      if (await maybeReopen(req)) reopened++;
    } catch (err) {
      console.warn(`⚠️  ${req._id} reopen : ${(err as Error).message}`);
    }
  }
  return { accepted, reopened, refreshed };
}

// ── SLOW : 1 wilaya par run (rotation sur les 58 via WILAYA_IDX) ─────────────
// Stateless: the cron passes WILAYA_IDX = (run_number mod 58) + 1, so the
// 58-wilaya rotation survives across runs with no memory. Full rotation =
// 58 runs ≈ 5h at a 5-min cadence — well under the 24h staleness threshold.
async function slowTick(wilaya: number): Promise<{ refreshed: number; wilaya: number }> {
  // 150 requêtes/wilaya : 15 professions × 10 — la limite 100 de l'API ne
  // suffit pas, on pagine par profession (10 req/profession ≪ 100).
  const PROFESSIONS = [
    'plumber', 'electrician', 'ac_repair', 'mason', 'mechanic',
    'appliance_repair', 'plasterer', 'welder', 'painter', 'carpenter',
    'cleaner', 'tailor', 'mover', 'barber', 'caterer',
  ];
  let refreshed = 0;
  for (const prof of PROFESSIONS) {
    try {
      const reqs = await api<DemoRequest[]>(
        `/service-requests?wilayaCode=${wilaya}&serviceType=${prof}&status=open,awaitingSelection&limit=50`,
      );
      for (const req of reqs) {
        if (!isDemoId(req._id)) continue;
        try {
          if (await refreshIfStale(req)) refreshed++;
        } catch (err) {
          console.warn(`⚠️  ${req._id} refresh : ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.warn(`⚠️  slow w${wilaya}/${prof} : ${(err as Error).message}`);
    }
  }
  return { refreshed, wilaya };
}

// ── Un cycle (single run — the cron calls this once then exits) ──────────────
async function tick(wilaya: number): Promise<void> {
  const fast = await fastTick();
  const slow = await slowTick(wilaya);
  console.log(
    `🔁 run ${new Date().toISOString()} wilaya=${wilaya} : ` +
    `✅ ${fast.accepted} accept | 🔄 ${fast.reopened} reopen | 📅 ${fast.refreshed + slow.refreshed} refresh`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  initFirebase();
  // Rotation input from the cron matrix (1–58). Defaults to 1 for manual runs.
  const wilaya = Math.min(58, Math.max(1, parseInt(process.env['WILAYA_IDX'] ?? '1', 10) || 1));
  console.log('Khidmeti demo watcher (stateless) | ' + `API=${API_BASE} wilaya=${wilaya}`);

  await tick(wilaya);
  console.log('🏁 run done.');
}

if (process.argv[1]?.includes('watcher')) {
  main().catch((err) => {
    console.error('\n❌ Erreur :', (err as Error).message);
    process.exit(1);
  });
}
