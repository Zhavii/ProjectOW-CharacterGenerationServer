module.exports = {
    apps: [{
        name: "app",
        script: "app/app.js",
        env: {
            NODE_ENV: "production",
            PORT: 80
        },
        watch: false,
        max_memory_restart: "31G",
    }]
};