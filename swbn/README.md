# Webblox IWA (`.swbn` 100 % autónomo)

Esta carpeta contiene el empaquetador para generar **Webblox** como una **Isolated Web App (`.swbn`)** de Chrome/Chromium totalmente autónoma:

- Incluye el motor oficial de Roblox (`WebClientApp`, ~255 MB) dentro del propio archivo `.swbn` para cargar directo desde disco.
- Usa **Direct Sockets (`TCPSocket`)** mediante [`webblox/direct-wisp.js`](../webblox/direct-wisp.js) para conectarse directamente a Roblox desde tu navegador, **sin servidor Wisp ni backend externo**.
- Permite iniciar sesión con **Quick Login** (código rápido) o pegando `.ROBLOSECURITY`.

## Descargar el `.swbn` listo desde GitHub

GitHub no permite guardar archivos mayores a 100 MB dentro de carpetas de Git, así que el workflow [`.github/workflows/build-swbn.yml`](../.github/workflows/build-swbn.yml) compila y publica `webblox.swbn` automáticamente en la pestaña **Releases** del repositorio.

*(Opcional)* Para mantener siempre el mismo ID (`isolated-app://...`) entre actualizaciones, guarda una clave privada Ed25519 en PEM en `Settings → Secrets and variables → Actions → IWA_SIGNING_KEY`.

## Cómo instalarlo en Chrome / Edge (escritorio)

1. Abre `chrome://flags` y activa:
   - `#enable-isolated-web-apps`
   - `#enable-isolated-web-app-dev-mode`
2. Reinicia el navegador.
3. Abre `chrome://web-app-internals/` → en **Install IWA from Signed Web Bundle** selecciona el archivo `webblox.swbn`.
4. Abre la app instalada **Webblox**, pulsa **Iniciar sesión → Generar código rápido** y apruébalo en `https://www.roblox.com/crossdevicelogin/ConfirmCode`.

## Compilar en local

```sh
bun install
bun run fetch:webblox   # Descarga ~255 MB a vendor/webblox/engine/
bun run build:proxy
bun run build:swbn      # Genera swbn/dist/webblox.swbn
```
