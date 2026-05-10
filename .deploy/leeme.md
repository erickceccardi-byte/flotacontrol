# `.deploy/` — auto-push para FlotaControl

Patrón similar a `D:\ecomotor\.deploy\` pero adaptado a GitHub Pages.

## Uso

1. **Doble-click** sobre `auto_push.bat`. Se abre una ventana negra que dice
   "FlotaControl AUTO-PUSH activo". **Dejala abierta**.
2. Mientras esa ventana esté corriendo:
   - Claude modifica archivos en la carpeta del repo.
   - Cada 30 segundos el script chequea y empuja los commits a GitHub.
   - GitHub Pages se actualiza ~1 minuto después.
   - Los choferes ven los cambios al abrir/refrescar la PWA.
3. **Para parar**: cerrá la ventana negra.

## Cómo arranca solo al prender la PC (opcional)

1. `Win+R` → `shell:startup` → Enter. Se abre la carpeta de Startup.
2. Click derecho sobre `auto_push.bat` → "Crear acceso directo".
3. Mové el acceso directo a la carpeta de Startup.

A partir de ahí, cada vez que prendas Windows, el auto-push arranca solo
y queda escuchando.

## Cómo funciona

- `git fetch origin main` — chequea si hay commits locales no pusheados.
- Si hay → `git push origin main` con las credenciales del usuario (Git
  Credential Manager de Windows, ya configurado en tu PC).
- Si no → espera otros 30 segundos.

## Seguridad

Las credenciales viven exclusivamente en tu PC (Credential Manager).
Claude solo hace commits — nunca toca tu token. El push usa tu config
local.
