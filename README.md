# Registrador local · Flujo en Proyecto

Plugin de servidor **independiente** para OpenCode **V2 2.1.2**, con SDK
`@opencode/plugin` fijado a `2.1.2`. Implementa los cortes
[#2](https://github.com/pablotecat/evagentic-flow/issues/2),
[#3](https://github.com/pablotecat/evagentic-flow/issues/3),
[#4](https://github.com/pablotecat/evagentic-flow/issues/4) y
[#5](https://github.com/pablotecat/evagentic-flow/issues/5): encargo admitido,
texto final, delegación, herramientas e interacciones humanas observables del proyecto autorizado,
con aviso e interrupción del conjunto observado ante fallos del registrador. No modifica
agentes, permisos de las sesiones observadas, delegación ni otros plugins.

**No se ha instalado ni activado en el proyecto consumidor.** La parada ante
fallos se comprueba también con delegación anidada, ramas concurrentes y
descendientes nuevos; entregables y cobertura del piloto
siguen pendientes. No utilizar este corte como
autorización para el piloto.

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
   el diario y `metadata.evagenticRecorder` de la sesión; `active` por sí solo no
   demuestra captura sana: también identifica un guardián activo con captura fallida.

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
node scripts/inspect.mjs C:/synthetic/captures ses_synthetic --tree
node scripts/inspect.mjs C:/synthetic/captures ses_synthetic --tools
```

También basta un lector de JSON por línea. El lector incluido no importa el
plugin ni requiere OpenCode, navegador o exportación. No ignora líneas inválidas:
termina con error indicando el archivo y la línea. No ordena eventos entre
diarios como si hubiera un orden causal global.

`--tree` incluye los descendientes relacionados por evidencia, sin exigir
activación por flujo. Las filas conservan padre, agente, llamada y sesión hija
cuando se observan; `null` significa relación desconocida o excluida, no una
asociación deducida. Los intervalos `session.execution.*` permiten reconocer
solapamientos: no sumar las duraciones de ramas concurrentes como duración global.

`--tools` produce un diagnóstico independiente por identidad compuesta de llamada
(sesión, mensaje y llamada), sin alterar la captura. Conserva cada intento, su
entrada, resultado/error filtrado, tiempos y referencias a las filas originales.
Una llamada abierta queda como `outcome-not-observed`, con causa y consumo
desconocidos: no acredita fallo, éxito ni consumo cero. El diagnóstico vale hasta
los horizontes de los diarios leídos; no declara una avería por consultar trabajo
todavía en curso. Se puede redirigir a un archivo **fuera de Git** para conservarlo.

El catálogo `recorder.tools.available` distingue herramientas registradas y nombres
vistos en el hook de contexto de las invocadas. No demuestra que un hook posterior
no cambie la selección. Un evento de herramienta no es una petición HTTP ni revela
sus servicios internos. No se agrupan reintentos por nombre, argumentos u orden:
cuando el runtime no expone el enlace, `retryOf` y `operationID` quedan en `null`.
Los reintentos de modelo expuestos en `session.retry.scheduled` se conservan aparte;
los reintentos HTTP internos del proveedor pueden no producir ese evento.

Las preguntas nativas usan formularios y las aprobaciones usan `permission.*`.
Se conservan solicitudes y respuestas, con enlaces públicos cuando existen, pero
la procedencia de una respuesta es **cliente externo no identificado**, no agente
ni persona autenticada. No se capturan formularios globales, metadata arbitraria,
campos ocultos, adjuntos ni respuestas sin un formulario autorizado observado.

Contrato y límites: [captura v1](docs/capture-v1.md).

## Si falla el registrador

- El título nativo de la sesión muestra **«Fallo del registrador · Revisar antes
  de volver a ejecutar»**. Su API pública `GET /api/session/{sessionID}` conserva
  en `data.metadata.evagenticRecorder` el aviso, la solicitud de interrupción,
  su resultado y si la parada quedó confirmada. También se informa en stderr.
  No requiere navegador conectado ni escribir en el destino averiado.
- Se solicita `session.interrupt` con `resume: false`; solo se declara parada
  confirmada tras `wait` y un desenlace público `interrupted` posterior a la
  solicitud. `not-running`, errores o comprobaciones que no concluyen se muestran
  como **`unconfirmed`**, no como éxito. No se revierten ni se garantiza cancelar
  inmediatamente efectos externos, herramientas no cooperativas o descendientes.
- La comprobación reenumera el proyecto después de cada oleada de interrupciones.
  Tras fallar la escritura, la suscripción sigue observando identidades y solicita
  interrumpir también nuevas sesiones autorizadas, sin seguir capturando contenido.
  Cada sesión mantiene su propio aviso y resultado; no hay una confirmación global
  ficticia. Los hooks de herramientas y shell bloquean nuevos despachos locales.
- La admisión y el despacho de modelos quedan bloqueados, también si un encargo
  estaba en preparación al fallar la captura. Se arma una marca durable **antes**
  de declarar preparado el registrador; solo una limpieza sana puede retirarla.
  Así, fallar al actualizar el diagnóstico o cerrar el proceso sin limpieza no
  pierde el bloqueo. Reparar el destino, recargar o reiniciar **no**
  elimina esa marca ni vuelve a emitir `recorder.ready`. Este corte no ofrece
  desbloqueo automático: revisar antes de cualquier nueva ejecución.
- En OpenCode 2.1.2, fallar `setup` no veta la admisión. Por eso el plugin mantiene
  activo el hook de bloqueo cuando falla la configuración o preparación; el HTTP
  de un encargo rechazado devuelve 500 sin cuerpo tipado, mientras el aviso queda
  consultable en la sesión. Sin configuración válida, se rechaza la admisión en
  la ubicación donde se cargó el plugin, sin autorizar captura ni interrupción
  de otras sesiones. Con configuración válida ajena, se retira el guardián.
- Si se pierde la ruta del proyecto, se sigue intentando interrumpir las sesiones
  cuya identidad y ubicación ya habían sido verificadas. No se autoriza una sesión
  nueva por inferencia ni se interrumpe una sesión trasladada fuera del alcance.
- Un runtime sin las capacidades comprobadas queda **no compatible y bloquea la
  preparación del piloto**: un estado público `failed` del cargador no demuestra
  que impida ejecutar. No sustituir estas comprobaciones por esa suposición.
  Si no se puede armar el estado durable inicial, tampoco existe garantía de
  recordar ese fallo después de perder todo el estado del runtime: no autorizar
  el piloto ni interpretar una base de datos nueva como una revisión.

La evidencia anterior no se borra. Consultar el diario con el lector independiente;
si se movió el destino para diagnosticar un fallo, usar su ubicación conservada.

## Seguridad y límites de esta entrega

- `.local/`, `*.local.json` y `captures/` están ignorados. Elegir capturas fuera
  de cualquier repositorio; Git no protege ubicaciones arbitrarias por sí solo.
  No se sube ni publica captura, configuración local o simulación automáticamente.
- Las exclusiones conocidas y patrones de credenciales se aplican antes de
  escribir. **No es anonimización universal** de texto libre. No se vuelcan
  cabeceras de transporte, configuración global, adjuntos ni metadata arbitraria.
  Los argumentos JSON autorizados y resultados textuales de herramientas pasan el
  mismo filtrado; claves sensibles también se excluyen en estructuras anidadas.
- Una respuesta parcial sin `session.text.ended` queda sin texto; sus eventos
  solo dejan metadatos y omisiones explícitas. No se hace backfill ni replay.
- Un fallo posterior deja `recorder.failed` si el diario sigue operativo. El aviso,
  la interrupción y el bloqueo no dependen de poder escribir esa fila. Los fallos
  de agente/herramienta registrados y las omisiones de cobertura no disparan esta
  política por sí solos. No ejecutar el piloto todavía.
- Auditoría npm (2026-11-21): 24 avisos moderados transitivos del SDK fijado,
  ninguno alto/crítico. La mayoría no tiene corrección disponible para esta
  versión. No se han forzado actualizaciones que alteren el contrato comprobado.
