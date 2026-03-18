---
description: Always use Page Object Model (POM) for Playwright Tests
---
# Playwright POM Best Practice

When creating or refactoring Playwright test scripts, **ALWAYS** practice the Page Object Model (POM) pattern. This makes scripts reusable, clean, and easy to maintain.

1. **Create a Model Class**:
   Place the model in `tests/models/{PageName}.ts`. 
   ```typescript
   import { Page, Locator } from '@playwright/test';

   export class ExamplePage {
       readonly page: Page;
       readonly exampleButton: Locator;

       constructor(page: Page) {
           this.page = page;
           this.exampleButton = page.locator('#example-btn');
       }

       async performAction() {
           await this.exampleButton.click();
       }
   }
   ```

2. **Use the Model in Spec Files**:
   Do not write raw locators (e.g., `page.locator(...)`) inside `.spec.ts` files whenever possible. Import the model and use its methods.

3. **Environment Setup**:
   Store base URLs and credentials in `.env` and load them via `process.env`. Do not hardcode them in models or setup scripts.

4. **Handling Game Loading Overlays**:
   When testing games (like those in an iframe), always explicitly wait for the parent page's loading overlay to disappear (`state: 'hidden'`) before interacting with elements inside the game frame. This prevents click interception errors and timeouts (especially on Webkit).
   ```typescript
   // Example
   await this.page.getByText('Loading game...').waitFor({ state: 'hidden' });
   ```

5. **Adding a New Game Test Structure**:
   To keep `tests/s9_test.spec.ts` clean as the main runner file, follow this 3-step process when adding a new game:
   1. **Create Page Object**: `tests/models/MyGamePage.ts`
   2. **Create Flow Function**: `tests/flows/myGameFlow.ts`
   3. **Execute in Main Spec**: Add `test('...', async ({ page }) => { await myGameFlow(page); });` to `tests/s9_test.spec.ts`
