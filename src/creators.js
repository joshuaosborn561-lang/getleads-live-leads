export const CREATORS = Object.freeze([
  { slug: "garypica", profileId: "01M0BZ5Q1A2569PZPC48XFNMD2", lane: "msp", campaignId: 3847939 },
  { slug: "robinrobins", profileId: "01M0BZ5G9V3E1ANPH39B5RN4C7", lane: "msp", campaignId: 3847940 },
  { slug: "thomaserb", profileId: "01M0VF4Z8TTFP645KAAQXRAP69", lane: "staffing", campaignId: 3847993 },
  { slug: "danmori", profileId: "01M0VF59V8M9PVW1TR4K2068B1", lane: "staffing", campaignId: 3847993 },
  { slug: "kortneyharmon", profileId: "01M0VF5K21G4YVRJGGTEGMF2R1", lane: "staffing", campaignId: 3847993 },
  { slug: "bradbialy", profileId: "01M0VF5WWH8QN5NPWJ6V2CV3B5", lane: "staffing", campaignId: 3847993 },
  { slug: "peterlehrman", profileId: "01M0VF673N01E9FG7W51VDGX0A", lane: "pe", campaignId: 3847995 },
  { slug: "kisonpatel", profileId: "01M0VF6J5K4XX91ZMX03Z36658", lane: "pe", campaignId: 3847995 },
]);

export const CREATOR_SLUGS = new Set(CREATORS.map((c) => c.slug));
export const CREATOR_PROFILE_IDS = new Set(CREATORS.map((c) => c.profileId));

export function isMonitoredProfile(profileId) {
  return CREATOR_PROFILE_IDS.has(profileId);
}
