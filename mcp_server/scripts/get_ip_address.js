/**
 * Description: Retrieves the local computer's IP address.
 * Usage: Run this script to print the primary IPv4 address assigned to the machine.
 * It uses the 'os' module to fetch network interfaces and filters for non-internal IPv4 addresses.
 */

const os = require('os');

function getIpAddress() {
    const interfaces = os.networkInterfaces();
    let ipAddresses = [];

    for (const name of Object.keys(interfaces)) {
        const iface = interfaces[name];
        for (const alias of iface) {
            // Filter out internal (loopback) and non-IPv4 addresses
            if (alias.family === 'IPv4' && !alias.internal) {
                ipAddresses.push(alias.address);
            }
        }
    }

    if (ipAddresses.length > 0) {
        console.log("Local IP Address(es):", ipAddresses.join(', '));
    } else {
        // Fallback to loopback if no external IP found (common in Docker/some environments)
        console.log("No external IP found. Primary Loopback IP: 127.0.0.1");
    }
}

getIpAddress();
