# Webblox IWA (`.swbn` 100 % autónomo)

> **Descargar `webblox.swbn` (~228 MB, listo para instalar):**
>
> - **[Descargar última versión (`webblox.swbn`)](https://github.com/broooooooooooooooooooooooooo/Webblox/releases/latest/download/webblox.swbn)**
> - **[Manifiesto de actualización automática (`update-manifest.json`)](https://github.com/broooooooooooooooooooooooooo/Webblox/releases/latest/download/update-manifest.json)**
> - **[Todas las releases](https://github.com/broooooooooooooooooooooooooo/Webblox/releases)**

*(Nota: GitHub prohíbe subir archivos mayores de 100 MB dentro de carpetas de Git —`webblox.swbn` pesa ~228 MB porque lleva el motor completo de Roblox dentro—, por eso el archivo compilado se entrega desde **Releases** mediante el enlace directo de arriba).*

---

## Qué incluye esta carpeta

- [`build-swbn.mjs`](https://github.com/broooooooooooooooooooooooooo/Webblox/blob/main/swbn/build-swbn.mjs): script que empaqueta `proxy/`, `webblox/`, `epoxy-transport` y el motor de Roblox (`vendor/webblox/engine/`) en `swbn/dist/webblox.swbn` firmado siempre con la misma clave Ed25519.
- [`update-manifest.json`](https://github.com/broooooooooooooooooooooooooo/Webblox/blob/main/swbn/update-manifest.json): manifiesto de actualizaciones automáticas de Chrome IWA (se actualiza solo en cada release de GitHub Actions).
- Conexión directa mediante **Direct Sockets (`TCPSocket`)** en [`webblox/direct-wisp.js`](https://github.com/broooooooooooooooooooooooooo/Webblox/blob/main/webblox/direct-wisp.js) (**sin servidor Wisp ni backend externo**).
- Inicio de sesión integrado con **Quick Login** (código rápido) o pegando `.ROBLOSECURITY`.

## Cómo instalarlo en Chrome / Edge (escritorio)

1. Abre `chrome://flags` y activa:
   - `#enable-isolated-web-apps`
   - `#enable-isolated-web-app-dev-mode`
2. Reinicia el navegador.
3. Abre `chrome://web-app-internals/` → en **Install IWA from Signed Web Bundle**, selecciona el archivo `webblox.swbn` descargado arriba *(o usa directamente la URL de `update-manifest.json` si tu versión de Chrome muestra la opción de instalación por Update Manifest)*.
4. Abre **Webblox**, pulsa **Iniciar sesión → Generar código rápido** y apruébalo en `https://www.roblox.com/crossdevicelogin/ConfirmCode`.

## Actualizaciones automáticas (`update-manifest.json`)

- El paquete `.swbn` incluye `"update_manifest_url": "https://github.com/broooooooooooooooooooooooooo/Webblox/releases/latest/download/update-manifest.json"` dentro de `/.well-known/manifest.webmanifest` y se firma siempre con la misma clave Ed25519 (`isolated-app://pg6isjl4i3jyh4z5xkxqmcdfwecxprqqt7ot5aklf63x43aibeqqaaic`).
- Cada vez que se publica una nueva release en GitHub Actions, `swbn/update-manifest.json` se actualiza automáticamente con la nueva versión y su enlace `.swbn`.
- Chrome comprueba actualizaciones automáticamente en segundo plano cada 4–6 horas (y también puedes forzar la búsqueda en `chrome://web-app-internals/`).

## Compilar una nueva versión desde GitHub

1. *(Ya configurado en este repo)* La clave privada Ed25519 en PEM está guardada en `Settings → Secrets and variables → Actions → IWA_SIGNING_KEY` para conservar el mismo ID `isolated-app://...` en todas las actualizaciones.
2. Ve a **Actions → [Build Standalone .swbn (Isolated Web App)](https://github.com/broooooooooooooooooooooooooo/Webblox/actions/workflows/build-swbn.yml) → Run workflow**.
3. Al terminar (~2 min), se publica el nuevo `webblox.swbn` en Releases y se actualiza `swbn/update-manifest.json` automáticamente.

## Compilar en local

```sh
bun install
bun run fetch:webblox   # Descarga ~255 MB a vendor/webblox/engine/
bun run build:proxy
bun run build:swbn      # Genera swbn/dist/webblox.swbn
```
