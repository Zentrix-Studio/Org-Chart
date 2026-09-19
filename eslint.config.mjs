import powerbiVisualsConfigs from "eslint-plugin-powerbi-visuals";

export default [
    powerbiVisualsConfigs.configs.recommended,
    {
        // Only build output / dev bundles are ignored — never source.
        ignores: ["node_modules/**", "dist/**", ".tmp/**", "harness/*.js"],
    },
    {
        // Cert plugin rules guard SHIPPED visual source only. Harness (dev-only
        // playground, never bundled into the .pbiviz) and tests are not shipped,
        // so the powerbi-visuals cert rules must not fire there.
        files: ["harness/**", "test/**", "scripts/**"],
        rules: Object.fromEntries(
            Object.keys(powerbiVisualsConfigs.rules).map((name) => [
                `powerbi-visuals/${name}`,
                "off",
            ])
        ),
    },
];
