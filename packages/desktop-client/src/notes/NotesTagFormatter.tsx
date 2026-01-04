import React from 'react';

import { useResponsive } from '@actual-app/components/hooks/useResponsive';

import { DesktopTaggedNotes } from './DesktopTaggedNotes';
import { MobileTaggedNotes } from './MobileTaggedNotes';

type NotesTagFormatterProps = {
  notes: string;
  onNotesTagClick?: (tag: string) => void;
};

export function NotesTagFormatter({
  notes,
  onNotesTagClick,
}: NotesTagFormatterProps) {
  const { isNarrowWidth } = useResponsive();

  const words = notes.split(' ');
  const regex = /#(?<tag>[^\s|\(|\#]+)(?:\((?<comment>[^\(]+)\))?/gm;
  let lastIndex = 0;

  let results = [];
  for (const match of notes.matchAll(regex))
  {
    //return earlier string raw
    if(match.index > lastIndex)
    {
      results.push(notes.slice(lastIndex, match.index));
    }

    //add the tag object
    if (isNarrowWidth) {
      results.push (
        <MobileTaggedNotes
          content={`#${match.groups["tag"]}`}
          tag={match.groups["tag"]}
          separator={" "}
        />
      );
    } else {
      results.push(
        <DesktopTaggedNotes
          onPress={onNotesTagClick}
          content={`#${match.groups["tag"]}`}
          comment={match.groups["comment"]}
          tag={match.groups["tag"]}
          separator={" "}
        />
      );
    }

    //add any remaining strings raw
    if( lastIndex < notes.length )
    {
      results.push(notes.slice(lastIndex))
    }
  }

  return (
    <>
      {results}
    </>
  );
}
