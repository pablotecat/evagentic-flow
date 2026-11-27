# Interfaz web cliente en React con Vite, Tailwind CSS y servido paralelo seguro

Reabre una única decisión del
[ADR 0010](0010-webapp-local-ejecucion-simple.md): la restricción de interfaz
sin framework. El resto queda intacto y reafirmado. Implementa el primer corte
vertical de [#37](https://github.com/pablotecat/evagentic-flow/issues/37)
([#42](https://github.com/pablotecat/evagentic-flow/issues/42)).

## Decisiones

- **Sólo cambia la capa cliente del navegador.** La interfaz se reescribe en
  **React + TypeScript**, compilada por **Vite** y con estilo
  **Tailwind CSS v4** e iconos de **Lucide**, servida como estáticos por el
  servidor local existente. Todo lo demás se conserva tal cual: servidor HTTP
  de la biblioteca estándar de Node en `127.0.0.1`, guard de `Host`/`Origin`,
  contratos `/api/*` públicos sin cambios, candado por proyecto,
  idempotencia por `requestKey`, índice persistente sin contenido del encargo
  ni de la respuesta, y captura leída por el lector independiente del
  [ADR 0008](0008-lector-independiente-y-semantica-de-evidencia.md) con su
  semántica conservadora (nada se rellena, toda ausencia es desconocida y
  nunca cero, el desenlace técnico no es aceptación).
- **Servido en paralelo bajo `/next`.** El servidor publica la interfaz
  compilada en `/next/` (redirección de `/next` a `/next/`), con normalización
  estricta de ruta decodificada frente a recorridos (`..`, `%2e%2e`, barras
  invertidas, byte nulo y codificaciones inválidas rechazados con `404`),
  contención comprobada contra el directorio de salida, MIME exacto por
  extensión, `X-Content-Type-Options: nosniff` y el mismo guard de
  `Host`/`Origin` que el resto de la app. El cliente actual de
  `webapp/public/` sigue servido en `/` sin cambios. Ningún endpoint
  `/api/*`, esquema, código de estado, candado, reconciliación o regla de
  persistencia del índice se modifica.
- **Salida compilada fuera de Git, build y desarollo integrados.** El cliente
  vive en `webapp/client/` con su propia configuración TypeScript, se compila a
  `webapp/dist/` (ignorado por Git y, por tanto, ajeno al lint de comentarios
  por diseño del inventario) con `base: './'` para que los recursos resuelvan
  bajo `/next/` y, más adelante, en `/`. El comando `build` del repositorio
  compila también la interfaz; `typecheck` comprueba `src/` y el cliente;
  `dev:webapp` ejecuta Vite con un proxy HTTP de `/api/*` hacia el servidor
  local (puerto `WEBAPP_PORT` 4173 por defecto o destino `WEBAPP_TARGET`).
- **Estado cliente modular y reconciliación no destructiva.** El estado se
  organiza en porciones independientes y tipadas contra las respuestas
  exactas de `/api/*`: salud, catálogo de opciones (con recarga manual),
  histórico de ejecuciones en sondeo permanente —también mientras se inspecciona
  una ejecución— y detalle de ejecución, con guardas de secuencia por petición
  para que una respuesta tardía no sobrescriba una selección más reciente.
  React reconcilia por claves estables, de modo que foco, borradores y
  desplegables sobreviven a cada ciclo de sondeo.
- **Enrutado por hash.** `#/` (nuevo encargo), `#/rubrics` y
  `#/executions/<id>/<tab>` con pestaña `conversation` por defecto
  (`conversation`, `deliverables`, `trace`, `evaluation`) y parámetro
  `?session=` opcional dentro del hash para el alcance de subejecución. La
  recarga, los enlaces directos y el historial del navegador conservan vista,
  ejecución, pestaña y subejecución sin tocar ninguna ruta del servidor.
- **Divulgación progresiva y vocabulario del dominio.** Barra lateral fija
  (cajón adaptable en pantallas estrechas) con el alias «Flujo en Proyecto»,
  indicador compacto y expandible de salud del sistema —motor, captura e
  índice, incluidos `review-required`, fallo del registrador y la señal propia
  «Sin conexión con la app local»—, conmutador de tema Claro/Oscuro/Sistema
  persistido en `localStorage` y respetuoso con `prefers-color-scheme`,
  navegación principal e histórico filtrable (texto y estado). El compositor
  de «Nuevo encargo» mantiene el contrato exacto de `POST /api/executions`
  (`{ requestKey, command: { name, arguments } | text, agent?, model? }`),
  el envío con `Ctrl+Enter`/`Cmd+Enter`, los estados de carga/vacío/error con
  recarga manual del catálogo ([ADR 0011](0011-opciones-y-comandos-publicos.md))
  y avisos contextuales sólo cuando aplican: motor inaccesible, opción no
  disponible (`422`), índice en revisión (`503`) y proyecto ocupado (`409`)
  con enlace directo a la ejecución activa. La clave de solicitud se conserva
  al reintentar tras un fallo transitorio y rota al comenzar un encargo nuevo
  o tras una creación con éxito, igual que en el cliente anterior.

## Frontera de pruebas

- `test/webapp-static.test.mjs`: servido paralelo seguro de la interfaz
  compilada — redirección de `/next`, MIME exacto por extensión, `nosniff`,
  rechazo de recorridos y rutas desconocidas con `404`, métodos distintos de
  GET con `405`, guard de `Host`/`Origin` sobre `/next/` y cliente legado
  intacto en `/`.
- `test/webapp-ui-next.test.mjs`: navegador Playwright real contra la interfaz
  compilada servida por HTTP real, interceptando únicamente `/api/*` con
  `page.route`. Cubre navegación por barra lateral y cajón adaptable,
  conmutación y persistencia de tema, salud compacta y expandible (sana,
  revisión del índice, fallo del registrador, desconexión local), histórico en
  vivo mientras se inspecciona una ejecución con filtrado por texto y estado,
  compositor (estados de catálogo, recarga manual, envío por `Ctrl+Enter`,
  carga con comando y sin él, conservación de la clave de solicitud al
  reintentar con rotación tras un encargo nuevo o una creación, y avisos
  `422`/`503`/`409` con enlace a la ejecución activa) y persistencia del
  enrutado por hash con subejecución y navegación atrás/adelante.
- Las fronteras existentes —`test/webapp.test.mjs`, `test/browser.test.mjs`,
  `test/browser-ui.test.mjs`— siguen en verde sin cambios: los contratos
  `/api/*` no se tocan y el cliente legado se sigue sirviendo.

## Límites

- Este corte no puebla las pestañas de la vista de ejecución ni la vista de
  rúbricas: sólo el armazón con identidad y estado básicos. Conversación,
  entregables, traza, evaluación y rúbricas llegan en cortes posteriores
  (#39, #40, #44, #38, #43).
- El enlace de tema se persiste en el navegador (`localStorage`), como el
  resto de preferencias locales de la app; no añade estado en el servidor.
- `dev:webapp` delega `/api/*` al servidor local real mediante proxy HTTP de
  Vite; las credenciales y la configuración de producción siguen residiendo
  sólo en la configuración local no versionada.
- El servido bajo `/next` es deliberadamente fase de transición hacia la
  interfaz única de #41; retirar el cliente legado de `webapp/public/` y el
  prefijo `/next` exige actualizar las pruebas que hoy dependen de `/`.
