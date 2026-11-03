# KiddyBooks

Éditeur + moteur de rendu de livres pour enfants animés, exportés en vidéo MP4 (YouTube).

Un projet = un dossier `projects/<nom>/` contenant `project.json` (schéma : `src/shared/schema.ts`) et `assets/`
(`backgrounds`, `illustrations`, `audio`, `transitions`, `fonts`).

## Démarrer

Prérequis : Node 20+, ffmpeg dans le PATH (`winget install Gyan.FFmpeg`), Microsoft Edge ou Chrome.

```bash
npm install
npm run demo-assets   # médias factices pour tester
npm run dev           # éditeur : http://localhost:5173  (API : 5174)
```

Autre projet : `PROJECT_DIR=projects/ep2 npm run dev`.

## Architecture

- `src/shared/compile.ts` — JSON → timeline à plat (couches, transitions, événements audio) en temps global.
- `src/shared/render.ts` — `renderFrame(ctx, project, compiled, media, t)` : **le même code** dessine l'aperçu et l'export.
- `src/web/` — éditeur (scènes, styles, audio, médias, projet), aperçu temps réel avec audio WebAudio.
- `src/server/export.ts` — export : Edge headless rend chaque image (WebM alpha inclus) → ffmpeg (H.264) ;
  l'audio multipiste est mixé d'abord en WAV (`adelay`, `volume`, `afade`, boucle, `amix`) puis muxé en AAC.

## Conventions du JSON

- Temps en secondes, relatifs à la scène. `position` d'un texte = point d'ancrage ; d'une image/vidéo = coin supérieur gauche.
- Polices : déposer `assets/fonts/Merriweather-Bold.ttf` ; l'identifiant est le nom de fichier sans extension.
- `transition_to_next` : vidéo alpha superposée, centrée par défaut sur la coupure (`offset` pour décaler).
- Un média manquant est rendu en placeholder rouge et signalé dans l'export.
