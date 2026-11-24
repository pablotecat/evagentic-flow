# Código sin comentarios

Las explicaciones de decisiones viven en `docs/adr/`; la deuda de implementación,
en GitHub Issues. El código y las pruebas expresan el comportamiento. Para repetir
la revisión, usa `/delete-comment [ruta o alcance]`, que carga la skill local
`delete-comment`.

## Regla `no-comments`

`npm run lint` comprueba todos los archivos propios JS/TS (incluidos JSX/TSX,
MJS/CJS y MTS/CTS) y JSON/JSONC que Git enumera como versionados o nuevos no
ignorados. Incluye archivos ocultos. Se analizan con TypeScript ya instalado:
URLs, regex, texto JSX y contenido literal de plantillas no son comentarios;
los comentarios dentro de expresiones de plantilla o JSX sí lo son. Las
directivas escritas como comentarios también cuentan; el shebang se conserva.

Los archivos Markdown y YAML son documentación/configuración, no forman parte
de esta regla sintáctica. Los dos YAML existentes durante la auditoría también
se revisaron y no contenían comentarios. Dependencias, compilados, capturas,
configuración local ignorada y repositorios anidados ajenos quedan fuera del
inventario de código propio. Un lenguaje nuevo requiere ampliar la regla con
su analizador, no aplicar una regex a literales.

`npm test` ejecuta el lint antes de compilar. El workflow
`.github/workflows/comments.yml` ejecuta la regla y sus pruebas en pushes y PRs.

## Ratchet

`.comment-baseline.json` permite únicamente comentarios heredados exactos por
archivo, SHA-256 del texto (saltos de línea normalizados) y número de apariciones. Mover líneas en el mismo
archivo no rompe el permiso; cambiar texto, duplicarlo o trasladarlo a otro
archivo sí. Cada permiso pendiente debe tener clasificación y destino en la
revisión que lo conserva. En CI se compara además el baseline con la revisión
base del PR o el estado anterior al push (`--base <ref>`): tampoco se permite
ampliar permisos editando el JSON a mano. Una base histórica sin fichero de
baseline equivale a un presupuesto vacío; una referencia Git inválida falla.

Después de retirar comentarios, `npm run lint:comments:ratchet` reduce los permisos.
Se niega a escribir si aparece un comentario no permitido. El lint también falla
si quedan permisos de comentarios ya eliminados, para que el presupuesto nunca
quede disponible para reutilizarlo. Un baseline ausente o inválido es un error.
No hay comando para regenerar permisos a partir del estado actual.

Esta primera revisión pudo retirar todos los comentarios y deja el baseline vacío;
el mecanismo sigue admitiendo limpiezas parciales de permisos heredados.
`npm run comments:inventory` emite ubicaciones, texto, hashes, líneas ocupadas y
líneas completas eliminables. La [auditoría inicial](comment-audit.md) conserva
las clasificaciones y destinos de los 68 comentarios originales.
