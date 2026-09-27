# Planner validation — client ke saamne bolne ka Hinglish script

Yeh script verified backend results par based hai. “Test mein” ka matlab automated backend test hai; browser mein demonstration ka claim nahi. Rule-wise report: [Original rules versus tests](planner-client-rule-test-report.md).

## Opening

“Main aapko planner ke placement rules aur unke test results explain karta hoon. Humne valid layout accept hone ke saath invalid layout reject hone ko bhi check kiya hai. Is review mein passage width, corners, irregular hall boundary, open sides, rotated stalls, split numbering aur save/reload cover kiye hain.

Frontend preview ka role editing ke waqt feedback dena hai. Save hone se pehle final validation backend karta hai. Aaj jo test results main share kar raha hoon, woh backend aur running API ke verified results hain.”

## 1. Passage width: 3 se 5 metres

“Passage width 3 se 5 metres ke beech configure hoti hai. Agar setting nahi di, toh default 3 metres hai. 3.5 metres jaisi beech ki value bhi valid hai.

Test mein 3, 3.5 aur 5 metres accept hue. 2.99, 5.01, zero, negative aur invalid-format values reject hui. Invalid request se layout save nahi hua.

Yahan do cheezein alag hain: setting 3–5 metres ki hai; actual free gap isse zyada bhi ho sakta hai. Jaise selected width 5 metres ho, toh 6 metres ka actual clear gap allowed hai.”

## 2. Corner stalls ka passage

“Corner wale stall aur neighbouring stalls ke beech selected width ka clear passage mandatory hai.

Humne 3 metre setting par exact 3 metre gap accept aur 2.99 metre gap reject check kiya. Isi tarah 5 metre setting par exact 5 metres accept aur 4.99 metres reject hua.

Corner par touching stalls ko back-to-back exception dekar clearance bypass nahi karne diya gaya. Ye checks rotated layouts par bhi kiye gaye.”

## 3. Hall ki actual shape

“Planner hall ki actual boundary use karta hai. L-shaped hall ho ya boundary mein cut-out ho, toh uske bahar ki khali jagah ko usable passage nahi maana jata.

Test mein aisa stall rakha jiske corner points andar the, lekin uska edge ek narrow cut-out cross kar raha tha. Woh reject hua. Ek aur case mein stalls ke beech ka gap hall ke bahar ke notch se pass ho raha tha; use bhi valid passage nahi maana gaya.

Blocked floor holes aur circular hall ki actual radius ke against bhi checks hue.”

## 4. Back-to-back touching kab allowed hai

“Non-corner stalls back-to-back touch kar sakte hain, jab unka common back edge ho aur dono ki open sides opposite directions mein, shared edge se bahar ki taraf face karein. Current validated arrangement mein har stall ki exactly ek open side hoti hai.

Valid example mein ek stall upar ki taraf open hai aur doosra neeche ki taraf, aur unki backs milti hain. Yeh arrangement accept hua, rotation ke saath bhi.

Same direction mein opening, opening ko common edge ki taraf rakhna, ya sirf ek point par touching jaise cases reject hue. Positive-length shared back edge wala valid partial contact accept hua.”

## 5. Har open side ke saamne passage

“Har open side ki poori edge ke saamne selected width ka clear passage chahiye. Sirf stall ke centre ke saamne thodi khali space hona enough nahi hai.

Humne FRONT, BACK, LEFT aur RIGHT chaaron sides par test kiya. Required passage ke andar doosra stall 1 millimetre bhi enter kare, toh tested case reject hua.

Multiple open sides wale stall mein ek side block hone par bhi placement reject hua. Do facing stalls ek doosre ka passage block karein, toh audit dono affected stalls ki problem report karta hai.”

## 6. Rotation aur actual edge distance

“Distance stall ke centre se nahi, uski actual rotated edges se measure hoti hai. Stall rotate hone par uski open sides ki direction bhi rotate hoti hai.

Test mein rotated exact 3 metre edge gap accept hua aur 2.99 metre gap reject hua. Aisa case bhi reject hua jahan centre andar tha, lekin rotated stall ka corner boundary ke bahar chala gaya.

Humne 36 different angles, teen passage settings aur boundary ke dono point orders combine kiye. Is matrix mein 648 layout scenarios check hue: exact gap, insufficient gap aur valid touching backs.”

## 7. Split numbering

“Stall ya section ka identifier 5-10 ho, toh system ise identifier hi maanta hai; 5 by 10 dimensions nahi.

Split karne par children 5-10-A, 5-10-B aur aage isi sequence mein bante hain. Z ke baad AA aur AB aata hai.

Actual API test mein 28 children create karke A se Z, phir AA aur AB verify kiye. Save aur reload ke baad bhi identifiers same rahe. Parent-child relationship aur nested split ki numbering bhi check hui.”

## 8. Duplicate prevention aur atomic split

“Split ke dauran duplicate records aur half-completed state se bachna bhi tested hai.

Humne same split request paanch baar ek saath bheji. Sab retries ne success return kiya, lekin database mein sirf ek child set aur ek split record bana.

Do competing split requests mein sirf ek successful hui; doosri ko conflict mila.

Humne jaan-boojhkar split ke beech database insert fail karwaya. Us case mein aadhe children save nahi hue aur parent ki previous state safe rahi. Failure remove karne ke baad retry successful hui.”

## 9. Move, rotate, resize aur save/reload

“Validation sirf new stall banate waqt nahi hoti. Existing layout ko move, rotate, resize, split ya save karte waqt final arrangement check hota hai.

Agar passage setting 3 se 5 metres kar di, toh unchanged stalls bhi dobara validate hote hain. Purana 3 metre gap ab insufficient ho, toh save reject hota hai.

Invalid update ke baad previous saved layout intact raha. Valid save/reload mein geometry, rotation, selected rules, open sides, identifiers aur parent-child relationship preserve hue.

Hall resize ka test bhi hua: hall aur layout ki stored dimensions consistent milni chahiye.”

## 10. Baaki planner restrictions aur auto-layout

“Existing configured rules mein wall clearance, restricted zones, emergency/door access aur stall-size snapping bhi check hue. For example, 1 metre wall clearance configured ho, toh 0.5 metre gap reject aur exact 1 metre accept hua. Emergency access ko block karna bhi reject hua.

Cancelled stall spatial blockage mein count nahi hota, lekin active ya booked stall passage block kare, toh usko consider kiya jata hai.

Auto-layout ke rows, back-to-back, island aur perimeter arrangements ko rectangular, irregular aur circular halls par check kiya. Har generated layout ke saare stalls ek saath validate kiye gaye. Final persistence phir bhi normal save validation se hoti hai.”

## 11. Testing ka actual outcome

“Is audit mein humne system ko intentionally fail karne ki koshish ki. Chhe issues mile: specific rotation par geometry crash, large coordinates par missed overlap, missing audit error, extreme-coordinate crash, numbering overflow aur hall resize ke baad stale dimensions.

Inhe fix karke tests rerun kiye. Final result 355 unit tests, 30 integration tests aur running API ke 19 Playwright tests pass hai. Type-check aur backend build bhi pass hai.

Yeh 404 total backend tests hain; inmein configuration aur API compatibility tests bhi included hain. Main ise 404 separate planner rules ya every possible case covered hone ka claim nahi kar raha.”

## 12. Scope aur closing

“Ek existing exception transparent rakhna zaroori hai: token-protected historical seed import purane layouts ke liye placement checks bypass kar sakta hai. Normal planner save ke liye woh route use nahi hona chahiye.

Is review mein frontend browser interactions aur live external AI-provider calls test nahi kiye gaye. Backend validation, local PostgreSQL persistence aur running API ke results verify kiye gaye hain.

Aapko rule-wise report mein har tested scenario ka expected behavior aur actual result mil jayega. Detailed report mein failure reproductions, fixes aur exact test commands bhi available hain.”

