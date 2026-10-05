import '../setup-env';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const XLSX = require('../../../frontend-angular/node_modules/xlsx');
const columns=['name','bare_rate','shell_rate','two_side_open_rate_percent','three_side_open_rate_percent','four_side_open_rate_percent','catlog_entry_charge','tax_mode','cgst_percent','sgst_percent','igst_percent','emc_name','emc_markup_percent','emc_fixed_charge','emc_taxable'];
const captures=join(__dirname,'../../test-results/pricing-review');
test.setTimeout(120_000);
for(const width of [1440,390]) test(`pricing workflow in browser at ${width}px`,async({page,request})=>{
  await page.setViewportSize({width,height:width===1440?900:844});
  mkdirSync(captures,{recursive:true});
  const masters:number[]=[];
  const name=`Browser pricing ${width} ${Date.now()}`;
  const data={layoutName:name,hall:{name:'Test hall',shape:'SQUARE',width:40,length:40,rules:{}},
    stalls:[{name:'Price test stall',width:6,length:6,height:3,posX:0,posZ:0,openSides:['FRONT','LEFT']}]};
  const created=await request.post('/api/layout/save',{data});expect(created.status()).toBe(201);
  const saved=await created.json(),id=saved.layout.id,number=saved.stalls[0].stallNumber;
  // Real API and dedicated test database; the frontend still runs at its normal CORS origin.
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    await route.fulfill({response:await route.fetch({url:'http://127.0.0.1:18081'+url.pathname+url.search})});
  });
  await page.addInitScript(()=>localStorage.setItem('stall-planner.guided-tour.v1','completed'));
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await page.goto('http://localhost:4200/planner/editor?layoutId='+id);
    await expect(page.getByRole('tab',{name:/Layouts/})).toBeVisible();
    const intro=page.getByRole('button',{name:'Got it, start planning'});
    if(await intro.isVisible()) await intro.click();
    await page.getByRole('tab',{name:/Layouts/}).click();
    const panel=page.locator('app-pricing-panel');
    await panel.getByRole('button',{name:'New master',exact:true}).click();
    await panel.getByLabel('Name',{exact:true}).fill(name);
    await panel.getByLabel('Bare rate / m² (₹)',{exact:true}).fill('100');
    await panel.getByLabel('Shell rate / m² (₹)',{exact:true}).fill('150');
    await panel.getByLabel('2 open sides (%)',{exact:true}).fill('10');
    await panel.getByLabel('Tax mode',{exact:true}).selectOption('IGST');
    await panel.getByLabel('IGST (%)',{exact:true}).fill('18');
    await panel.getByLabel('Markup (%)',{exact:true}).fill('5');
    await panel.getByLabel('Fixed charge (₹)',{exact:true}).fill('25');
    await panel.getByLabel('Apply the selected tax rates to EMC charges').check();
    await page.screenshot({path:join(captures,`form-bottom-${width}.png`),fullPage:true});
    await panel.getByLabel('Name',{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:join(captures,`form-top-${width}.png`),fullPage:true});
    const saving=page.waitForResponse(r=>r.url().endsWith('/api/price-masters') && r.request().method()==='POST');
    await panel.getByRole('button',{name:'Save price master',exact:true}).click();
    const master=await(await saving).json();masters.push(master.id);expect(master.id).toBeTruthy();
    // Reject an actual duplicate save from the bottom of the long form. Feedback must become
    // visible/focused without discarding the user's entries, at both desktop and mobile widths.
    await panel.getByRole('button',{name:'New master',exact:true}).click();
    await panel.getByLabel('Name',{exact:true}).fill(name);
    await panel.getByLabel('Bare rate / m² (₹)',{exact:true}).fill('100');
    await panel.getByRole('button',{name:'Save price master',exact:true}).click();
    const error=panel.locator('[data-pricing-error]');
    await expect(error).toContainText('already exists');await expect(error).toBeFocused();await expect(error).toBeInViewport();
    await page.screenshot({path:join(captures,`error-${width}.png`),fullPage:true});
    await error.getByRole('button',{name:'Return to price form'}).click();
    await expect(panel.getByLabel('Name',{exact:true})).toBeFocused();await expect(panel.getByLabel('Name',{exact:true})).toHaveValue(name);
    await panel.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(panel.getByRole('button',{name:'Apply rates to layout'})).toBeEnabled();
    await panel.getByRole('button',{name:'Apply rates to layout'}).click();
    await expect(panel.getByText(/Rates applied to layout/)).toBeVisible();
    await panel.getByLabel('Saved stall',{exact:true}).selectOption(number);
    await panel.getByRole('button',{name:'Calculate price'}).click();
    await expect(panel.locator('app-price-breakdown')).toContainText('4,935.94');
    await panel.locator('app-price-breakdown .total').scrollIntoViewIfNeeded();
    await page.screenshot({path:join(captures,`applied-${width}.png`),fullPage:true});
    await panel.locator('summary').click();
    const download=page.waitForEvent('download');await panel.getByRole('button',{name:'Download template'}).click();
    expect((await download).suggestedFilename()).toBe('price-masters-template.xlsx');
    const workbook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([columns,[name+' imported',200,null,0,0,0,0,'NONE',0,0,0,'',0,0,false]]),'Price masters');
    await panel.getByLabel('Choose price workbook').setInputFiles({name:'test-prices.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})});
    await expect(panel.getByText('1 masters ready for review. Nothing has been saved.')).toBeVisible();
    await panel.getByRole('button',{name:'Import 1 masters'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:join(captures,`import-${width}.png`),fullPage:true});
    const importing=page.waitForResponse(r=>r.url().endsWith('/api/price-masters/import'));
    await panel.getByRole('button',{name:'Import 1 masters'}).click();
    const imported=await(await importing).json();masters.push(...imported.map((m:any)=>m.id));expect(imported).toHaveLength(1);
    const published=await request.post(`/api/layout/${id}/publish`,{data:{...data,stalls:saved.stalls}});expect(published.status(),await published.text()).toBe(200);
    await page.goto('http://localhost:4200/planner/view?layoutId='+id);
    await page.locator('.xv-row').filter({hasText:'Price test stall'}).click();
    const details=page.locator('app-exhibitor-stall-details');
    await expect(details.locator('app-price-breakdown')).toContainText('4,935.94');
    await details.getByRole('button',{name:'Book stall Price test stall'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:join(captures,`quote-${width}.png`),fullPage:true});
    await page.screenshot({path:join(captures,`quote-viewport-${width}.png`)});
    await details.getByRole('button',{name:'Book stall Price test stall'}).click();
    const dialog=page.getByRole('alertdialog');await expect(dialog).toContainText('4,935.94');
    const booking=page.waitForResponse(r=>r.url().endsWith('/book'));
    await dialog.getByRole('button',{name:'Book stall',exact:true}).click();
    const response=await booking;expect(response.status(),await response.text()).toBe(200);
    expect((await response.json()).quote.total).toBe(4935.94);
    await expect(details.getByText(/Booked. Your stall reference/)).toBeVisible();
    expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  } finally {
    await request.delete('/api/layout/'+id);
    if(masters.length) {
      const db=new Client({host:process.env.DATABASE_HOST,port:Number(process.env.DATABASE_PORT??5432),user:process.env.DATABASE_USER,password:process.env.DATABASE_PASSWORD,database:'stall_designer_test'});
      await db.connect();try { await db.query('DELETE FROM price_masters WHERE id = ANY($1::bigint[])',[masters]); } finally { await db.end(); }
    }
  }
});
