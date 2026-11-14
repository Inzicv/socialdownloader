# socialdownloader

Application de bureau pour enregistrer des vidéos et de l'audio depuis un lien (YouTube, TikTok, Instagram, X et les autres sites pris en charge par yt-dlp).

L'appli pilote [yt-dlp](https://github.com/yt-dlp/yt-dlp) directement depuis Electron : pas de serveur local, pas de port ouvert, et les requêtes partent de ta propre connexion. Elle est pensée pour un usage personnel sous Windows.

## Fonctions

- **Un lien** : colle-le puis « Télécharger », en vidéo MP4 ou en audio MP3, en HD (meilleure qualité disponible) ou Standard (720p maximum).
- **Par lot** : plusieurs liens, un par ligne, ou l'import d'une playlist, d'une collection ou d'une chaîne entière.
- **File d'attente** : de 1 à 6 téléchargements en parallèle, avec pourcentage, vitesse et temps restant.
- **Historique local** : un clic rouvre le fichier ; l'historique s'exporte et s'importe en JSON.
- **Reprise** : un téléchargement annulé ou interrompu repart de là où il s'était arrêté.
- **Presse-papiers et glisser-déposer** : un lien copié est proposé au retour sur la fenêtre, et un lien peut être déposé dessus.
- **Session navigateur** : pour les contenus qui demandent d'être connecté, l'appli peut réutiliser la session de Firefox, Chrome, Edge ou Brave.

## Prérequis

- [Node.js](https://nodejs.org) 22 ou plus récent.
- [ffmpeg](https://ffmpeg.org) installé et présent dans le `PATH` (par exemple `winget install Gyan.FFmpeg`). Sans lui, la haute qualité et le MP3 ne fonctionnent pas.
- `yt-dlp` n'est pas à installer : l'appli le télécharge au premier lancement depuis les versions officielles, puis le met à jour à chaque démarrage.

## Installation et lancement

```bash
npm install
```

```bash
npm start
```

## Utilisation

1. Choisis le dossier de destination avec « Changer de dossier » (par défaut `Téléchargements\Social Downloader`).
2. Colle un lien, choisis le format et la qualité, puis clique sur « Télécharger ».
3. Le média apparaît dans l'historique. Un clic sur la ligne ouvre le fichier, la coche l'affiche dans son dossier, la croix le retire de la liste.

Pour les contenus privés ou réservés aux comptes connectés, ouvre « Réglages » dans la barre latérale et choisis le navigateur dans lequel tu es connecté. Firefox est le plus fiable ; Chrome et Edge refusent souvent l'accès à leurs cookies sous Windows.

## Où sont rangées les données

Tout reste sur l'ordinateur, dans `%APPDATA%\socialdownloader\` :

| Élément | Emplacement |
|---|---|
| Réglages | `settings.json` |
| Historique | `history.json` |
| yt-dlp | `bin\yt-dlp.exe` |

## Organisation du code

| Fichier | Rôle |
|---|---|
| `main.js` | Fenêtre, réglages, détection des outils (yt-dlp, ffmpeg), canaux IPC |
| `preload.js` | Pont entre la fenêtre et le processus principal |
| `lib/ytdlp.js` | Arguments yt-dlp, lecture de la progression, analyse et téléchargement |
| `lib/queue.js` | File d'attente et parallélisme |
| `lib/store.js` | Lecture et écriture atomique des fichiers JSON |
| `ui/` | Interface en HTML, CSS et JavaScript, sans étape de build |
| `test/` | Tests unitaires du moteur et de la file |
| `scripts/smoke.js` | Lance la vraie appli et capture chaque vue |

Côté sécurité, la fenêtre est isolée (`contextIsolation`, `sandbox`, politique de contenu stricte) et ne peut appeler que les canaux listés dans `preload.js`. Les liens sont toujours passés à yt-dlp comme arguments séparés, jamais à travers un shell.

## Tests

```bash
npm test
```

Lancement réel avec captures d'écran dans le dossier `captures` :

```bash
npx electron scripts/smoke.js captures
```

Avec la variable d'environnement `SMOKE_DOWNLOAD=1`, ce script télécharge aussi une courte vidéo de test dans le dossier de destination.

## Limites connues

- Les publications Instagram composées uniquement de photos ne sont pas prises en charge par yt-dlp.
- L'appli n'est ni signée ni empaquetée en installeur : elle se lance depuis les sources.
- Testée sous Windows uniquement.

## Crédits

- L'interface reprend celle de la version bureau de [Social Media Downloader](https://github.com/Vette1123/social-media-downloader) de Mohamed Gado (licence MIT), dont ce projet s'inspire.
- Le téléchargement repose sur [yt-dlp](https://github.com/yt-dlp/yt-dlp) et [ffmpeg](https://ffmpeg.org).
- Police [Geist](https://vercel.com/font) de Vercel, sous licence SIL Open Font License (voir `ui/fonts/Geist-LICENSE.txt`).

Enregistre uniquement les contenus que tu as le droit de conserver.
