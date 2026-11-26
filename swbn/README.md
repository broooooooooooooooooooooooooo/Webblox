# Webblox IWA (`.swbn` 100 % autónomo)

> **Descargar `webblox.swbn` (~228 MB, listo para instalar):**
>
> - **[Descargar última versión (`webblox.swbn`)](https://github.com/broooooooooooooooooooooooooo/Webblox/releases/latest/download/webblox.swbn)**
> - **[Ver versión actual (`iwa-v1.0.1`)](https://github.com/broooooooooooooooooooooooooo/Webblox/releases/tag/iwa-v1.0.1)**
> - **[Todas las releases](https://github.com/broooooooooooooooooooooooooo/Webblox/releases)**

*(Nota: GitHub prohíbe subir archivos mayores de 100 MB dentro de carpetas de Git —`webblox.swbn` pesa ~228 MB porque lleva el motor completo de Roblox dentro—, por eso el archivo compilado se entrega desde **Releases** mediante el enlace directo de arriba).*

---

## Qué incluye esta carpeta

- [`build-swbn.mjs`](https://github.com/broooooooooooooooooooooooooo/Webblox/blob/main/swbn/build-swbn.mjs): script que empaqueta `proxy/`, `webblox/`, `epoxy-transport` y el motor de Roblox (`vendor/webblox/engine/`) en `swbn/dist/webblox.swbn` firmado con Ed25519.
- Conexión directa mediante **Direct Sockets (`TCPSocket`)** en [`webblox/direct-wisp.js`](https://github.com/broooooooooooooooooooooooooo/Webblox/blob/main/webblox/direct-wisp.js) (**sin servidor Wisp ni backend externo**).
- Inicio de sesión integrado con **Quick Login** (código rápido) o pegando `.ROBLOSECURITY`.

## Cómo instalarlo en Chrome / Edge (escritorio)

1. Abre `chrome://flags` y activa:
   - `#enable-isolated-web-apps`
   - `#enable-isolated-web-app-dev-mode`
2. Reinicia el navegador.
3. Abre `chrome://web-app-internals/` → en **Install IWA from Signed Web Bundle**, selecciona el archivo `webblox.swbn` descargado arriba.
4. Abre **Webblox**, pulsa **Iniciar sesión → Generar código rápido** y apruébalo en `https://www.roblox.com/crossdevicelogin/ConfirmCode`.

## Compilar una nueva versión desde GitHub

1. *(Opcional, para conservar el mismo ID `isolated-app://...` entre actualizaciones)* Guarda tu clave privada Ed25519 en PEM en `Settings → Secrets and variables → Actions → IWA_SIGNING_KEY`.
2. Ve a **Actions → [Build Standalone .swbn (Isolated Web App)](https://github.com/broooooooooooooooooooooooooo/Webblox/actions/workflows/build-swbn.yml) → Run workflow**.
3. Al terminar (~2 min), el nuevo `webblox.swbn` aparecerá automáticamente en el enlace de descarga de arriba.

## Compilar en local

```sh
bun install
bun run fetch:webblox   # Descarga ~255 MB a vendor/webblox/engine/
bun run build:proxy
bun run build:swbn      # Genera swbn/dist/webblox.swbn
```
