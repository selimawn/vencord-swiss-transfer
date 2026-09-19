# Swiss Transfer for Vencord

Vencord userplugin that adds an **Upload** button next to GIFs, stickers and gifts. Files go to [Swiss Transfer](https://www.swisstransfer.com), then the plugin asks whether to insert the link in the chat box or send it.

This is **not** an official Infomaniak or Vencord plugin. The HTTP flow is based on the unofficial CLI [Blutsh/swissfer](https://github.com/Blutsh/swissfer).

## What it does

1. Click **Upload** in the Discord compose bar.
2. Choose **Files** (Finder / file picker) or **Photos** (images and videos).
3. The first time, Swiss Transfer emails a 6-character code to the address in the plugin settings. Enter it once; it is cached afterwards.
4. After the upload, choose **Insert** or **Send**.

Settings (same limits as the website):

- sender email
- availability: 1, 3, 7, 15 or 30 days
- max downloads: 1, 20, 100, 200 or 250
- optional password and message

Desktop only (Discord or Vesktop). The official `+` attachment button is left alone.

## Install

You need a Vencord install [built from source](https://docs.vencord.dev/installing/).

```sh
cd Vencord/src
mkdir -p userplugins
cd userplugins
git clone https://github.com/selimawn/vencord-swiss-transfer swissTransfer.desktop
cd ../..
pnpm build
pnpm inject   # Discord Desktop only; Vesktop users point Vesktop at this dist folder
```

Restart Discord, enable **Swiss Transfer** in Vencord settings, and set your sender email.

To update:

```sh
cd Vencord/src/userplugins/swissTransfer.desktop
git pull
cd ../../..
pnpm build
```

## Notes

- Swiss Transfer public uploads use email verification, not an Infomaniak API token.
- Anti-bot (Altcha) is solved locally. If Infomaniak tightens that, uploads may fail until the plugin is updated.
- Do not put this folder in `src/plugins`; it would conflict with official Vencord updates.

## License

GPL-3.0-or-later, same as Vencord and swissfer.
