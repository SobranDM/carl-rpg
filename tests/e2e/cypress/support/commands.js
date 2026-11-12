/* global Cypress, cy */

Cypress.Commands.add("turnOffWarningsIfTheyExist", () => {
  cy.get("#notifications")
    .if()
    .then((notifications) => {
      const buttons = notifications.find("li.notification");
      if (buttons.length) {
        buttons.trigger("click");
      }
    });
});

Cypress.Commands.add("licenseAgreeAndClickAccept", () => {
  cy.visit("/");
  cy.url().then((url) => {
    if (url.includes("/license")) {
      cy.get("#eula-agree").click();
      cy.get("#sign").click();
      cy.visit("/");
    }
  });
});

Cypress.Commands.add("setupInputPasswordAndClickLogin", () => {
  cy.url().then((url) => {
    if (url.includes("/auth")) {
      cy.get("#key", { timeout: 10000 }).type(Cypress.env("ADMIN_PASSWORD") ?? "");
      cy.get(".fa-unlock-keyhole", { timeout: 10000 }).parent().click();
      cy.visit("/");
    }
  });
});

Cypress.Commands.add("closeTourOverlay", () => {
  cy.log("Closing tour overlay");
  cy.get('[data-action="exit"]', { timeout: 10000 })
    .if()
    .then(() => {
      cy.get('[data-action="exit"]').click();
    });
  cy.get('.tour .header-button.close, [data-action="closeTour"]', { timeout: 5000 }).if().click({
    force: true,
  });
  cy.get(".step-title.noborder", { timeout: 10000 }).should("not.exist");
  cy.get(".tour-overlay", { timeout: 10000 }).should("not.exist");
});

Cypress.Commands.add("confirmWorldMigrationIfShown", () => {
  cy.contains("button", "Begin Migration", { timeout: 15000 }).if().click({ force: true });
});

Cypress.Commands.add("launchTestWorldFromSetup", (worldTitle) => {
  const name = worldTitle ?? Cypress.env("FOUNDRY_WORLD") ?? "carl-rpg";
  cy.url().then((url) => {
    if (url.includes("/join")) {
      cy.log("World already running (join page) — skip setup launch");
      return;
    }
    if (url.includes("/game")) {
      return;
    }
    cy.get("body").contains(name).should("be.visible").rightclick({ force: true });
    cy.get("body").contains("Launch").should("be.visible").click({ force: true });
    cy.confirmWorldMigrationIfShown();
    cy.get(".progress-bar", { timeout: 180000 }).should("not.exist");
    cy.closeTourOverlay();
    cy.get('select[name="userid"] option', { timeout: 180000 }).should("exist");
    cy.get('select[name="userid"] option').should("have.length.at.least", 1);
  });
});
