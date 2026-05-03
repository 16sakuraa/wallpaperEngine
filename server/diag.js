const si = require('systeminformation');

(async () => {
    console.log('--- CPU Temperature ---');
    const cpu = await si.cpuTemperature();
    console.log(JSON.stringify(cpu, null, 2));

    console.log('\n--- GPU Info ---');
    const gpu = await si.graphics();
    gpu.controllers.forEach((c, i) => {
        console.log(`[${i}] model: ${c.model}`);
        console.log(`    temp: ${c.temperatureGpu}`);
        console.log(`    util: ${c.utilizationGpu}`);
    });
})();
