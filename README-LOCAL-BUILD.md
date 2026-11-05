# OpenCode (v2 local) — build local de l'extension, migré sur l'API v2

Ce dossier est l'extension décompilée, migrée sur l'API **Opencode v2**, prête à charger en *unpacked*.
Elle remplace l'extension du store (id `mcbjjapbjcnkjopapebmnjineccfpofm`), qui parle v1 et ne peut pas marcher contre v2.

## Installer

1. Retirer/ désactiver l'extension du store « OpenCode » dans `edge://extensions`.
2. `edge://extensions` → activer **Mode développeur** → **Charger l'extension non empaquetée** → choisir `~/Documents/opencode-extension-chrome`.
3. Ouvrir le panneau latéral de l'extension, cliquer sur l'engrenage (Settings) et mettre :
   - **Server URL** : `http://localhost:49376`
   - **Username** : `opencode`
   - **Password** : la valeur de `password` dans `~/.config/opencode/service.json`
   - **Workspace** : le dossier à scoper (ex. `/Users/vakandi/Downloads/leaks_accounts`) — envoyé en `?directory=`
4. La pastille doit passer au vert avec `OpenCode 2.0.32`.

## Ce qui a été changé

- **`background.js` réécrit** : c'est le seul point de traduction v1 → v2. Toute requête, l'event stream et le prompt passent par lui.
- **`sidebar.js`** : une seule insertion en tête — la capture des logs (rien d'autre touché).
- **`manifest.json`** : `key` et `update_url` retirés (pour ne pas entrer en conflit avec l'extension du store), version `1.2.0`, nom `OpenCode (v2 local)`.

Mapping des routes (vérifié par curl sur le serveur) :

- santé `GET /global/health` → `GET /api/info`
- events `GET /global/event` → `GET /api/event`
- liste `GET /session` → `GET /api/session?directory=…` → `{data:[…]}`
- messages `GET /session/{id}/message` → `GET /api/session/{id}/message`
- prompt `POST /session/{id}/message` → `POST /api/session/{id}/prompt` `{id,text}`
- abort `POST /session/{id}/abort` → `POST /api/session/{id}/interrupt`
- rename `PATCH /session/{id}` → `PATCH /api/session/{id}`
- permission `POST /session/{id}/permissions/{p}` → `POST /api/session/{id}/permission/{p}/reply` `{decision}`
- question `POST /question/{q}/reply` → `POST /api/session/{id}/form/{q}/reply` `{answer}`

## Lire les logs (le point important)

Trois niveaux, tous lisibles :

1. **Logs du service worker (background)**, dans `chrome.storage.local` clé `ocLogs` (ring de 1000, survit au kill du worker).
   Lecture depuis la page du side panel ou n'importe quelle page de l'extension :
   `chrome.storage.local.get("ocLogs").then(s => console.log(s.ocLogs.slice(-100)))`
2. **Logs de la sidebar**, dans `window.__ocLog` (ring de 3000) + console. Depuis la page du side panel :
   `JSON.stringify(window.__ocLog.slice(-100))`
   `window.__ocDumpBg()` renvoie aussi le ring du background.
3. **Console live** : le service worker (via `edge://extensions` → *service worker*) et le side panel loguent tout en `[oc-bg …]` et `[oc-sidebar …]`.

Ce qui est loggué : chaque requête (v1 → v2, méthode, body tronqué, status, corps tronqué), chaque event SSE reçu, chaque prompt, la santé, les erreurs.

## Limites connues

- La forme exacte des `data` de certains events a été lue dans le bundle SDK v2 et le schéma d'events, pas capturée en live (ça enverrait un prompt réel dans une session). Les cas couverts : `session.text.delta/ended`, `session.tool.called/success/failed`, `session.step.started/ended`, `session.execution.*`, `permission.asked/replied`, `session.deleted/renamed/compacted`.
- Le flux SSE est global (`/api/event`), filtré sur la session souscrite. À la fermeture du side panel le stream reste ouvert.
- Création de session : la localisation vient du `?directory=`. Si elle est vide, le serveur prend son projet par défaut.
