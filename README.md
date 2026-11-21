# Registrador local · Flujo en Proyecto

Plugin de servidor **independiente** para OpenCode **V2 2.1.2**, con SDK
`@opencode/plugin` fijado a `2.1.2`. Implementa el corte de
[#2](https://github.com/pablotecat/evagentic-flow/issues/2): encargo admitido y
texto final de respuesta, persistidos durante la ejecución de un único proyecto
autorizado. No modifica agentes, permisos, delegación ni otros plugins.

**No se ha instalado ni activado en el proyecto consumidor.** La parada ante
fallos (#3), subejecuciones, herramientas, entregables y cobertura del piloto
siguen pendientes. No utilizar este corte como autorización para el piloto.

## Desarrollo y pruebas

Requisitos comprobados: Node 26, npm, Git, OpenCode 2.1.2 y Postman CLI 1.83.1
(simulación local; sin login, workspace ni publicación). Node mínimo: 22.

```sh
npm ci
npm run typecheck
npm test
```

Las pruebas empaquetan e instalan el plugin en un directorio temporal, comprueban
las rutas aisladas **antes** de abrir la base de datos e inician `opencode serve`
en localhost con puerto aleatorio y contraseña sintética. Nunca llaman al servicio
compartido. Prueban APIs públicas y un lector JSONL independiente, no funciones
privadas. Usan dos repositorios temporales y un proveedor HTTP sintético servido
por Postman. No consumen créditos ni usan credenciales reales.

En Windows se detecta la instalación npm habitual del ejecutable; para otra
instalación, configurar `OPENCODE_TEST_BIN` con la ruta del binario. Se puede
configurar `OPENCODE_TEST_TMP` con un directorio temporal existente. Los datos de
prueba se conservan fuera del repositorio para inspección y se pueden borrar
manualmente cuando sus procesos hayan terminado.

Una prueba individual, después de `npm run build`:

```sh
node --test --test-name-pattern="el encargo" test/recorder.test.mjs
```

## Configuración local (solo tras autorizar la activación)

1. Compilar con `npm run build`. Esto **no** carga el plugin.
2. Copiar `examples/recorder.example.json` a una ubicación **no versionada**, por
   ejemplo `.local/recorder.local.json`. Sustituir las rutas sintéticas por rutas
   absolutas. Seleccionar exactamente un directorio y un destino **fuera** del
   proyecto observado. `secrets` enumera los valores literales conocidos que deben
   excluirse; no se descubren leyendo configuración global ni credenciales.
3. Establecer `EVAGENTIC_CONFIG` en el entorno **del servidor aislado** con la ruta
   absoluta de ese archivo. No basta con establecerlo en un cliente ya conectado.
4. En la instancia autorizada, añadir un archivo de entrada nuevo en su directorio
   local de plugins; preservar todos los archivos y plugins existentes:

   ```ts
   export { default } from "file:///C:/synthetic/recorder/dist/index.js";
   ```

   Esta carga por archivo público es la comprobada en 2.1.2. La entrada de paquete
   en `plugins` no llegó a activarse en la prueba de este binario en Windows;
   no se supone equivalente sin otra comprobación.
5. Iniciar esa instancia y admitir un encargo desde la interfaz nativa. OpenCode
   carga plugins de forma diferida: consultar la lista antes de una admisión
   puede devolver una lista vacía. Comprobar el estado público del plugin **y**
   el diario; `active` por sí solo no demuestra captura sana.

Para seleccionar el segundo proyecto solo cambian `projectDirectory` y, si se
desea, `captureDirectory`; recargar o reiniciar **la instancia aislada** para
volver a leer la configuración. No se autoriza aquí recargar otra instancia.
No se deduce el alcance exclusivamente de dónde esté instalado el plugin:
se verifican además la ubicación del evento y el proyecto/ubicación de la sesión.
Worktrees, subdirectorios y clones no se incorporan implícitamente.

## Consulta sin servidor

```sh
node scripts/inspect.mjs C:/synthetic/captures
node scripts/inspect.mjs C:/synthetic/captures ses_synthetic
```

También basta un lector de JSON por línea. El lector incluido no importa el
plugin ni requiere OpenCode, navegador o exportación. No ignora líneas inválidas:
termina con error indicando el archivo y la línea. No ordena eventos entre
diarios como si hubiera un orden causal global.

Contrato y límites: [captura v1](docs/capture-v1.md).

## Seguridad y límites de esta entrega

- `.local/`, `*.local.json` y `captures/` están ignorados. Elegir capturas fuera
  de cualquier repositorio; Git no protege ubicaciones arbitrarias por sí solo.
  No se sube ni publica captura, configuración local o simulación automáticamente.
- Las exclusiones conocidas y patrones de credenciales se aplican antes de
  escribir. **No es anonimización universal** de texto libre. No se vuelcan
  cabeceras, configuración global, adjuntos ni payloads de herramientas.
- Una respuesta parcial sin `session.text.ended` queda sin texto; sus eventos
  solo dejan metadatos y omisiones explícitas. No se hace backfill ni replay.
- Un fallo posterior se informa y deja `recorder.failed` si el disco permite
  escribir. La interrupción efectiva de trabajo es la issue #3, no está resuelta
  por este corte; no ejecutar el piloto todavía.
- Auditoría npm (2026-11-21): 24 avisos moderados transitivos del SDK fijado,
  ninguno alto/crítico. La mayoría no tiene corrección disponible para esta
  versión. No se han forzado actualizaciones que alteren el contrato comprobado.
