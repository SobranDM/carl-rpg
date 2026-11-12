describe("Smoke tests", () => {
  it("should visit the home page", () => {
    cy.visit("/");
    cy.get("body").should("exist", { timeout: 10000 });
  });

  it("should login", () => {
    cy.visit("/");
    cy.licenseAgreeAndClickAccept();
    cy.setupInputPasswordAndClickLogin();
    cy.closeTourOverlay();
    cy.launchTestWorldFromSetup();
    cy.loginAsGM();
    cy.get("body").should("exist", { timeout: 10000 });
  });

  it("loads the carl-rpg system", () => {
    cy.visit("/");
    cy.licenseAgreeAndClickAccept();
    cy.setupInputPasswordAndClickLogin();
    cy.closeTourOverlay();
    cy.launchTestWorldFromSetup();
    cy.loginAsGM();

    // carl-rpg ships its Quench batches inside the system (module/quench/),
    // so only the Quench module itself has to be enabled in the world.
    cy.window({ timeout: 120000 }).should((win) => {
      expect(win.game.system.id, "game.system.id").to.eq("carl-rpg");
      expect(win.game.modules.get("quench")?.active, "quench module active").to.eq(true);
    });
  });
});
