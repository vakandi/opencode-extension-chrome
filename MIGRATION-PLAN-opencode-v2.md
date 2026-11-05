# Plan — porter l'extension OpenCode sur l'API OpenCode v2

## Le problème, en une phrase

L'extension connectée (`OpenCode` 1.1.1) parle l'**API v1** (`/global/health`, `/session/{id}/message`, `/global/event`), le serveur qui tourne est **opencode v2.0.32** (tout sous `/api/...`). D'où « Not connected ».

## Sources des faits (à ne pas re-deviner)

- Le bundle SDK de la web app v2 : `/_assets/*.js` téléchargés depuis `http://127.0.0.1:49376`, dans `/tmp/ocfull/`.
- Les réponses live du serveur sur `http://127.0.0.1:49376` (Basic `opencode:<pass>`).
- Le code de l'extension décompilé : `~/Documents/opencode-extension-chrome/decompiled/`.

## Ce qui change v1 → v2

- **Base des routes** : `/global/*` et `/session/*` en v1, tout sous `/api/*` en v2.
- **Auth** : identique. `Authorization: Basic base64("opencode:" + password)`. Confirmé dans le client v2 (`btoa("opencode:"+password)`). Le user reste `opencode`.
- **Santé** : v1 `GET /global/health` ; v2 `GET /api/info` → `{version, pid, urls, paths, capabilities}`.
- **Événements (SSE)** : v1 `GET /global/event` — et l'extension l'appelle en **dur** sur `http://localhost:4096/global/event` ; v2 `GET /api/event`. L'enveloppe change : v1 `{payload:{type,properties}}` → v2 `{id, type, data}`.
- **Liste sessions** : v1 `GET /session` → tableau nu ; v2 `GET /api/session` → `{data:[...]}`, query `{limit,order,search,parentID,directory,project,subpath,cursor}`.
- **Création session** : v1 `POST /session` ; v2 `POST /api/session`, body `{id,parentID,title,agent,model,location,metadata,permissions}`.
- **Messages** : v1 `GET /session/{id}/message` ; v2 `GET /api/session/{id}/message`, query `{limit,order,cursor,type}` → `{data:[...]}`.
- **Envoi de prompt** : v1 `POST /session/{id}/message`, body `{parts:[{type:"text",text}]}` ; v2 `POST /api/session/{id}/prompt`, body `{id,text,files,agents,skills,metadata,delivery,resume}`. Le POST renvoie le message ; **la sortie streamée arrive sur `/api/event`**, plus sur la réponse du POST.
- **Abandon** : v1 = annuler le fetch ; v2 = `POST /api/session/{id}/interrupt`.
- **Portée par dossier (nouveau)** : la plupart des endpoints v2 prennent un `directory` / `location`. Le serveur scope sur ce dossier. Le `workspacePath` de l'extension correspond à ça. Sans lui, le serveur retombe sur son propre cwd.
- **Autres endpoints utiles en v2** : `GET /api/model`, `GET /api/model/default`, `POST /api/session/{id}/model` ; `GET /api/agent`, `POST /api/session/{id}/agent` ; `GET /api/command`, `POST /api/session/{id}/command` ; permissions/formulaires : `GET /api/form`, `GET /api/permission/request`, `POST /api/session/{id}/permission/{...}`.

## Fichiers à changer

- `background.js` — la vérité de tout le HTTP : santé, SSE des events, prompt, proxy d'API, et le `localhost:4096` en dur.
- `sidebar.js` — lecture des nouvelles enveloppes, appel prompt, gestion des events, affichage modèle/agent.
- `assets/protocol-*.js` — constantes de messages (à peu près intactes).
- `manifest.json` — `host_permissions` pour inclure l'hôte/port v2 (ou `http://*/*`), bump de version.
- `content/extract.js` — aucun changement.

## Chantiers, dans l'ordre

1. **Auth + URL** : garder Basic, user `opencode` ; supprimer le `http://localhost:4096` en dur partout et toujours utiliser le `serverUrl` configuré.
2. **Santé** : `/global/health` → `/api/info`, lire `version`.
3. **Événements** : pointer `{serverUrl}/api/event` ; réécrire le parseur de lignes pour l'enveloppe `{id,type,data}` ; re-mapper le filtre par session et la détection de fin de message.
4. **Prompt** : changer l'endpoint et le body ; découpler « envoyer » (POST) de « lire le flux » (`/api/event`).
5. **Enveloppes** : déballer `{data:[...]}` et `{location, data}` côté sidebar.
6. **Dossier** : ajouter `?directory=<workspacePath>` (ou `location`) aux appels session/model/agent/form.
7. **Fonctions v2 à exposer** : liste/création de sessions, sélecteur agent + modèle, cartes permission/formulaire, interrupt.
8. **Manifest + version**, puis charger en unpacked pour tester.

## À confirmer avant de coder (à ne pas supposer)

- La forme exacte de `data` dans `message.part.updated` / `message.updated` en v2 (noms de champs). Verrouiller : s'abonner à `/api/event` pendant un prompt et capturer les frames. **Non fait** — ça enverrait un vrai prompt dans une session.
- Si `/api/session/{id}/prompt` stream aussi en SSE (le client v2 ne traite que `/api/event` comme flux, mais gère le SSE génériquement). À prouver.
- Si `location` doit être `?directory=` ou un objet ; le client utilise les deux. Trancher contre `/api/model?directory=...`.
- Le port du serveur est dynamique (49376 là, dans `~/.config/opencode/service.json`) ; l'extension ne peut pas lire ce fichier, donc URL + mot de passe restent manuels.

## Test

- Charger unpacked, URL `http://localhost:49376`, user `opencode`, pass depuis `service.json`.
- Santé verte → version 2.0.32 affichée.
- Liste des sessions chargée avec `directory`.
- Envoyer « hello » → le POST renvoie, le flux affiche la réponse.
- Interrupt fonctionne.
- Vérif par **console + réseau**, pas screenshot.
