---
name: delete-comment
description: Clasifica y retira comentarios conservando decisiones en ADR e implementaciones pendientes en GitHub Issues.
disable-model-invocation: true
---

# Retirar comentarios

Las rutas siguientes parten de la raíz del repositorio. Usa el alcance solicitado;
sin argumentos, revisa todo el código propio incluido en `npm run comments:inventory`.

1. Consulta `docs/comment-policy.md` para el alcance y el ratchet. Si existen,
   lee `docs/agents/domain.md` y su contexto, y, antes de publicar deuda,
   `docs/agents/issue-tracker.md` y `docs/agents/triage-labels.md`. Si faltan,
   usa los ADR disponibles y publica deuda mediante `gh issue create --repo
   pablotecat/evagentic-flow --body-file <archivo>` con etiqueta `needs-triage`,
   tras comprobar el destino. Conserva cambios ajenos.
2. Ejecuta `npm run comments:inventory` y guarda el inventario anterior fuera del
   repositorio. Lee cada comentario del alcance junto con su implementación,
   llamadas y pruebas hasta poder comprobar qué afirmaciones siguen vigentes.
3. Asigna una categoría y un destino a **cada** comentario:
   - **Tautology**: repite el código; elimínalo.
   - **Stale**: describe una implementación que ya no existe o una afirmación
     contradicha por el código actual; elimínalo.
   - **Excuse**: justifica una solución frágil o deuda aplazada; busca una issue
     existente y publica la deuda o enlaza la adecuada antes de eliminarlo.
     Incluye evidencia y criterios verificables; una copia local no sustituye
     la publicación. Si GitHub falla, declara el bloqueo y conserva el permiso
     exacto pendiente, sin fingir que se ha publicado.
   - **Decision Record**: explica una restricción o elección no obvia vigente;
     traslada el porqué y sus consecuencias a un ADR relacionado o al siguiente
     número libre en `docs/adr/`, y elimina el comentario. Una deuda no se acepta
     como arquitectura para evitar abrir su issue.
4. Registra ubicaciones anteriores, categorías, razones y enlaces en el informe
   de la revisión. Antes de borrar directivas operativas o avisos legales,
   resuelve su efecto o requisito; si no puedes, déjalos pendientes en el ratchet.
   Conserva literales, regex, plantillas, shebangs y comportamiento del programa.
5. Ejecuta `npm run lint:comments:ratchet`: solo retira permisos de comentarios
   eliminados; conserva los pendientes exactos y sus destinos. Ejecuta
   `npm run lint`, `npm run typecheck`, `node --test test/comments.test.mjs` y las
   pruebas afectadas. Si cambia comportamiento, sepáralo de esta limpieza.
6. Comprueba que cada entrada del inventario tiene acción o pendiente explícito.
   Informa cuántos comentarios se retiraron, cuántas líneas completas se ahorraron,
   cuántos quedan, los ADR, las issues publicadas y las pruebas ejecutadas.
