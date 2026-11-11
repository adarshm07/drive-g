import * as THREE from 'three';

// Shop types for the interactive shops in Kannur town. `lines` are things the shopkeeper says.
export const SHOP_TYPES = [
  { id: 'chaya', name: 'Chayakada', ml: 'ചായക്കട', sign: '#7a2e1d', action: 'chai',
    lines: ['Strong chaya and hot pazham pori, fresh out of the oil.', 'Sit for a minute. Nobody drives well without a chaya.', 'Rain or sun, the kettle here never goes cold.'] },
  { id: 'bakery', name: 'Bakery', ml: 'ബേക്കറി', sign: '#c62828', action: 'chai',
    lines: ['Banana chips fried this morning. Take a packet for the road.', 'People come from Thalassery side just for our cake.', 'Try the egg puffs before the school crowd finishes them.'] },
  { id: 'handloom', name: 'Handloom Store', ml: 'കൈത്തറി', sign: '#1565c0',
    lines: ['Kannur handloom, woven here in the district. Feel the cloth.', 'These mundus last longer than your car tyres.', 'Weavers here have been at it for generations.'] },
  { id: 'coconut', name: 'Tender Coconut Stall', ml: 'ഇളനീർ', sign: '#2e7d32',
    lines: ['Cold ilaneer! Better than anything in a bottle.', 'You will find plenty of coconuts along the roads. Collect them for the leaderboard.', 'The beach road is full of coconuts today.'] },
  { id: 'fish', name: 'Fish Stall', ml: 'മീൻ കട', sign: '#00796b',
    lines: ['Fresh catch from Ayikkara harbour this morning.', 'Kallummakkaya season is the best time to visit.', 'The boats came in early today. Good mathi and ayala.'] },
  { id: 'workshop', name: 'Car Workshop', ml: 'വർക്ക്ഷോപ്പ്', sign: '#ef6c00',
    lines: ['Stuck somewhere? Press R and you are back on the highway.', 'The 4x4 handles the sand best. The sedan is quickest on NH 66.', 'Go easy on the drive-in beach, the tide comes up fast.'] },
  { id: 'medical', name: 'Medical Store', ml: 'മെഡിക്കൽസ്', sign: '#2e7d32',
    lines: ['Open till late, every day. Drive carefully and you will not need me.', 'Seat belt on? Good. That is the best medicine on NH 66.'] },
  { id: 'mobile', name: 'Mobile Shop', ml: 'മൊബൈൽസ്', sign: '#6a1b9a',
    lines: ['Recharge, covers, repairs, everything here.', 'Press M and the whole map opens. No phone needed!'] },
  { id: 'textile', name: 'Textiles', ml: 'ടെക്സ്റ്റൈൽസ്', sign: '#ad1457',
    lines: ['Onam collection just arrived. Kasavu sarees, set mundu, all here.', 'Half of Kannur buys wedding clothes on this road.'] },
  { id: 'vegetable', name: 'Vegetable Shop', ml: 'പച്ചക്കറി', sign: '#558b2f',
    lines: ['Nendran bananas straight from the farm.', 'Fresh today: tapioca, drumstick, yam. What do you need?'] },
  { id: 'hotel', name: 'Hotel (Meals Ready)', ml: 'ഹോട്ടൽ · ഊണ് റെഡി', sign: '#d84315', action: 'chai',
    lines: ['Meals ready! Fish curry, thoran, sambar, as much rice as you want.', 'Thalassery biryani on Fridays. Come early or it is gone.'] },
  { id: 'juice', name: 'Cool Bar', ml: 'കൂൾ ബാർ', sign: '#0277bd', action: 'chai',
    lines: ['Lime soda, sharjah shake, fresh juice. What will you have?', 'Too hot to drive without a cold drink.'] },
  { id: 'lottery', name: 'Lottery Stall', ml: 'ലോട്ടറി', sign: '#f9a825',
    lines: ['Tomorrow is the draw! One ticket could buy you a real car.', 'You collect coconuts, I sell luck. Both are honest work.'] },
  { id: 'petrol', name: 'Petrol Pump', ml: 'പെട്രോൾ പമ്പ്', sign: '#c62828',
    lines: ['Full tank? In this game the tank never runs dry, lucky you.', 'Buses, lorries, autos, I have filled them all. You can drive any of them: walk up and press F.'] },
];

export const KEEPERS = ['Rameshan', 'Ashraf', 'Latha', 'Shaji', 'Fathima', 'Biju', 'Kunhiraman', 'Joseph', 'Sreeja', 'Nazar', 'Prakashan', 'Shyamala', 'Rafeeq', 'Vinod', 'Beena', 'Manoj', 'Sajeevan', 'Haris', 'Deepa', 'Babu', 'Suhara', 'Anil', 'Jameela', 'Dineshan', 'Thomas', 'Radha', 'Salim', 'Girija'];

const L = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
const SHIRTS = [0x1565c0, 0xc62828, 0x2e7d32, 0xf9a825, 0x6a1b9a, 0x00838f].map(L);
const SKIN = L(0xb07a4f), MUNDU = L(0xf5f1e6), HAIR = L(0x1c1c1c);

/** A simple low-poly shopkeeper, about 1.7 units tall, facing +z. */
export function makeKeeper(i, shirt) {
  const g = new THREE.Group();
  const part = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
  part(0.55, 0.85, 0.34, MUNDU, 0, 0.43, 0);            // mundu
  part(0.6, 0.62, 0.36, shirt ? L(shirt) : SHIRTS[i % SHIRTS.length], 0, 1.16, 0); // shirt
  part(0.34, 0.34, 0.32, SKIN, 0, 1.64, 0);             // head
  part(0.36, 0.12, 0.34, HAIR, 0, 1.84, 0);
  const arm = part(0.14, 0.55, 0.16, SKIN, 0.38, 1.3, 0);
  part(0.14, 0.55, 0.16, SKIN, -0.38, 1.15, 0);
  g.userData.arm = arm;
  g.userData.len = 0.4;
  return g;
}
