# Social Downloader (version légère)

Téléchargeur de médias en ligne pour usage personnel. L'appli pilote `yt-dlp` directement : pas de serveur local, pas de port ouvert.

## Lancer

```bash
npm install
```

```bash
npm start
```

## Ce que ça fait

- Colle un lien puis « Télécharger » : vidéo MP4 ou audio MP3, en HD ou Standard (720p).
- Téléchargement par lot : plusieurs liens, un par ligne, ou import d'une playlist entière.
- Historique exportable et importable (JSON).
- Téléchargements en parallèle (1 à 6), avec progression, vitesse et temps restant.
- Un lien copié ailleurs est proposé dès que la fenêtre reprend le focus.
- Un téléchargement interrompu se reprend avec « Réessayer » (yt-dlp continue le fichier partiel).
- Réglages (barre latérale) → « Utiliser la session d'un navigateur » pour les contenus qui demandent d'être connecté.

## Organisation

| Fichier | Rôle |
|---|---|
| `main.js` | Fenêtre, réglages, outils (yt-dlp, ffmpeg), canaux IPC |
| `lib/ytdlp.js` | Arguments yt-dlp, lecture de la progression, analyse et téléchargement |
| `lib/queue.js` | File d'attente et parallélisme |
| `lib/store.js` | Lecture et écriture atomique des fichiers JSON |
| `preload.js` | Pont entre la fenêtre et le processus principal |
| `ui/` | Interface (HTML, CSS, JS, sans étape de build) |

Réglages, historique et `yt-dlp` vivent dans `%APPDATA%\mon-downloader\`. `yt-dlp` se met à jour seul à chaque démarrage. `ffmpeg` doit être installé sur la machine (présent dans le PATH).

## Vérifier

```bash
npm test
```

Lancement réel avec captures d'écran (s'arrête à l'aperçu ; `SMOKE_DOWNLOAD=1` télécharge aussi) :

```bash
npx electron scripts/smoke.js captures
```

## Limite connue

Les publications Instagram composées uniquement de photos ne sont pas prises en charge par yt-dlp.
