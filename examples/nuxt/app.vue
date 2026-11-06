<script setup lang="ts">
// Nuxt's template uses this value; Biome does not analyze template bindings.
// biome-ignore lint/correctness/noUnusedVariables: referenced by Vue template
const title = 'Logbird Nuxt integration';
</script>
<template><main>{{ title }}: POST /api/demo then GET /api/_logbird/events</main></template>
