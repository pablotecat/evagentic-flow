# Interfaz web cliente en React con Vite y Tailwind CSS

Reabre una única decisión del
[ADR 0010](0010-webapp-local-ejecucion-simple.md): la restricción de interfaz
sin framework. El resto queda intacto y reafirmado. Implementa el primer corte
vertical de [#37](https://github.com/pablotecat/evagentic-flow/issues/37)
([#42](https://github.com/pablotecat/evagentic-flow/issues/42)) y su fase de
contracción
([#41](https://github.com/pablotecat/evagentic-flow/issues/41)).

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
- **Servido por defecto en `/` y retiro del cliente legado.** El servidor publica la
  interfaz compilada en `/` (y en `/index.html`), con normalización estricta de ruta
  decodificada frente a recorridos (`..`, `%2e%2e`, `%5c`, barras invertidas,
  byte nulo y codificaciones inválidas rechazados con `404`), contención comprobada
  contra el directorio de salida con `realpath`, MIME exacto por extensión,
  `X-Content-Type-Options: nosniff`, `405` para métodos distintos de GET y el mismo
  guard de `Host`/`Origin` que el resto de la app. El prefijo paralelo temporal
  `/next` y el cliente legado de `webapp/public/` quedaron retirados: `/next`,
  `/next/`, `/app.js` y `/styles.css` devuelven `404` y el directorio legado se
  eliminó. Ningún endpoint `/api/*`, esquema, código de estado, candado,
  reconciliación o regla de persistencia del índice se modifica.
- **Salida compilada fuera de Git, build y desarrollo integrados.** El cliente
  vive en `webapp/client/` con su propia configuración TypeScript, se compila a
  `webapp/dist/` (ignorado por Git y, por tanto, ajeno al lint de comentarios
  por diseño del inventario) con `base: './'` para que los recursos resuelvan
  directamente bajo `/`. El comando `build` del repositorio
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

- `test/webapp-static.test.mjs`: servido seguro de la interfaz compilada en `/` —
  index HTML con React, MIME exacto por extensión, `nosniff`, rechazo de
  recorridos y rutas desconocidas o retiradas (`/app.js`, `/next`, `/next/`)
  con `404`, métodos distintos de GET con `405`, guard de `Host`/`Origin` y
  enlaces simbólicos que no pueden escapar de `webapp/dist`.
- `test/browser-ui.test.mjs`: navegador Playwright real contra la interfaz
  compilada servida por HTTP real en `/`, interceptando únicamente `/api/*` con
  `page.route`. Cubre navegación por barra lateral y cajón adaptable,
  conmutación y persistencia de tema, salud compacta y expandible (sana,
  revisión del índice, fallo del registrador, desconexión local), histórico en
  vivo mientras se inspecciona una ejecución con filtrado por texto y estado,
  compositor (estados de catálogo, recarga manual, envío por `Ctrl+Enter`,
  carga con comando y sin él, conservación de la clave de solicitud al
  reintentar con rotación tras un encargo nuevo o una creación, y avisos
  `422`/`503`/`409` con enlace a la ejecución activa), cabecera de ejecución con
  detención y metadatos forenses copiables, banda prioritaria, conversación en
  Markdown seguro con conmutador a texto plano, preguntas y permisos nativos con
  borradores aislados y respuestas registradas, sondeo no destructivo,
  protección contra respuestas obsoletas, las cuatro dimensiones de la traza
  (árbol, línea temporal, herramientas, métricas y skills y cobertura),
  entregables con procedencia plegada, evaluaciones agrupadas con
  reevaluaciones y contradicciones, y vista dedicada de rúbricas con
  maestro-detalle y anomalías. Sin inyección de scripts ni acceso a estado
  interno: sólo la frontera pública `/api/*`.
- `test/browser.test.mjs`: la suite E2E completa contra la instancia real de
  OpenCode 2.1.2 aislada, el registrador real y el proveedor HTTP sintético,
  operando sobre la nueva interfaz en `/` (barra lateral, compositor, cabecera
  de ejecución, banda prioritaria, las cuatro pestañas y la vista dedicada de
  rúbricas) y conservando todas las garantías previas: disponibilidad, envío
  único idempotente, carrera simultánea, recarga sin relanzar, exclusión entre
  pestañas, reinicio del servidor, caída del motor, intervenciones humanas de
  raíz y subejecución, pérdida HTTP en intervención, detención confirmada y no
  confirmada, fallo del registrador con bloqueo durable, exploración de árbol y
  traza, entregables con modificación y borrado del archivo original y consulta
  sin motor, y vistas de evaluación y rúbricas sin despachar trabajo adicional.
- Las fronteras existentes —`test/webapp.test.mjs`, `test/comments.test.mjs` y
  el resto de suites del registrador— siguen en verde sin cambios: los
  contratos `/api/*` no se tocan.

## Límites

- Las pestañas de la vista de ejecución y la vista de rúbricas llegaron en cortes
  posteriores (#39, #40, #44, #38, #43); la fase de contracción (#41) las activó
  por defecto en `/` y retiró el cliente legado, el prefijo `/next` y la suite de
  pruebas puras ligada a variables globales del cliente anterior.
- El enlace de tema se persiste en el navegador (`localStorage`), como el
  resto de preferencias locales de la app; no añade estado en el servidor.
- `dev:webapp` delega `/api/*` al servidor local real mediante proxy HTTP de
  Vite; las credenciales y la configuración de producción siguen residiendo
  sólo en la configuración local no versionada.
