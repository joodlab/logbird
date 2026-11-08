import { createMaintenanceClickHouseClient } from '../src/client';
import { migrate } from '../src/migrations';

const ch = createMaintenanceClickHouseClient();
try {
  await migrate(ch);
  console.log('ClickHouse migrations current');
} finally {
  await ch.close();
}
