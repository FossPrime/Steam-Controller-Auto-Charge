<script setup lang="ts">
defineProps<{
  controller: any
}>()
</script>

<template>
  <div class="status-container">
    <span class="pill">🔋{{ controller.batteryPercent }}% ({{ controller.batteryVoltage }}mV)</span>
    <span class="pill">⚡&#xFE0F;: {{ controller.isCharging === null ? '?' : (controller.isCharging ? 'YES' : 'NO') }}</span>
    <span class="pill">📶 {{ controller.signalStrength }} dBm</span>
  </div>
</template>

<style scoped>
.status-container {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-bottom: 15px;
}
.pill {
  background: #333;
  padding: 8px 16px;
  border-radius: 20px;
  font-family: monospace;
  font-size: 1.1rem;
  color: #2ecc71;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}
</style>
